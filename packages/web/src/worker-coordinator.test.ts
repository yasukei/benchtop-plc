import type {
  Diagnostic,
  RetentiveRecord,
  RuntimeSnapshot,
  UiToRuntimeMessage,
} from "@benchtop-plc/core";
import { expect, it } from "vitest";
import { createEditableWork, editSource, type WorkTransition } from "./editable-work.js";
import { FakeWorker } from "./fake-worker.test-support.js";
import { RuntimeClient } from "./runtime-client.js";
import type { StoreState } from "./store-state.js";
import { createWorkerCoordinator } from "./worker-coordinator.js";

const main = "PROGRAM Main\nVAR n : INT; END_VAR\nn := n + 1;\nEND_PROGRAM";
const snapshot: RuntimeSnapshot = {
  scanCount: 0,
  tasks: [],
  lastExecutionTimeMs: 0,
  inputs: [],
  outputs: [],
  variables: [],
  forced: [],
  annotations: [],
};
const diagnostic: Diagnostic = { code: "runtime.internal-error", severity: "error", args: {} };
const records: RetentiveRecord[] = [
  {
    kind: "leaf",
    path: "mainInstance.n",
    dataType: '{"TYPE":"INT"}',
    value: { dataType: "INT", value: 7 },
  },
];

function setup(retentive?: RetentiveRecord[]) {
  let state: StoreState = {
    ...createEditableWork(main),
    ...(retentive ? { retentive } : {}),
    storageWarning: false,
    retentiveSkipped: [],
    openDiagnostics: [],
    openProjectError: null,
    emergencyActive: false,
    emergencyReleased: false,
    loadedSources: null,
    loadedDataTypes: null,
    loadedConfigurationSource: null,
    runtimeState: "STOP",
    halted: null,
    selectedFrame: 0,
    snapshot: null,
    diagnostic: null,
    rejection: null,
    connection: "connected",
  };
  const worker = new FakeWorker();
  const client = new RuntimeClient(worker);
  const notified: { state: StoreState; sent: UiToRuntimeMessage[] }[] = [];
  const update = (patch: Partial<StoreState>) => {
    state = { ...state, ...patch };
    notified.push({ state, sent: [...worker.sent] });
    coordinator.synchronize();
  };
  const coordinator = createWorkerCoordinator(client, () => state, update);
  const load = () => {
    coordinator.load(state.editorIr!);
    const message = worker.sent.findLast((message) => message.type === "load")!;
    return message;
  };
  const apply = (transition: WorkTransition) => {
    coordinator.applySourceMappings(transition.mappings);
    update(transition.patch);
  };
  return { worker, client, coordinator, update, notified, load, apply, getState: () => state };
}

it("queues watches and breakpoints after load, before acknowledgement, and deduplicates notifications", () => {
  const { worker, coordinator, load, update, notified, getState } = setup();
  update({ breakpoints: { MAIN: [3] } });
  const message = load();
  expect(worker.sent.map((message) => message.type)).toEqual([
    "load",
    "watchBodies",
    "setBreakpoints",
  ]);
  expect(worker.sent[1]).toEqual({
    type: "watchBodies",
    bodies: [{ pou: "Main", instance: "mainInstance" }],
  });
  expect(getState().loadedIr).toBeUndefined();
  expect(notified.at(-1)?.sent).toEqual([]);
  worker.receive({ type: "snapshot", loadId: message.loadId, snapshot });
  expect(getState().loadedIr).toBe(message.ir);
  expect(getState().loadedSources).toEqual([main]);
  expect(worker.sent).toHaveLength(3);
  update({ breakpoints: { MAIN: [] } });
  expect(notified.at(-1)?.sent).toHaveLength(3);
  expect(worker.sent[3]).toEqual({ type: "setBreakpoints", breakpoints: [] });
  coordinator.synchronize();
  expect(worker.sent).toHaveLength(4);
  coordinator.dispose();
});

it.each(["snapshot", "fault"] as const)(
  "keeps newer loads pending when an older load replies with %s",
  (type) => {
    const { worker, coordinator, load, getState } = setup();
    const first = load(),
      second = load();
    worker.receive({ type: "snapshot", snapshot });
    worker.receive({ type: "snapshot", loadId: 999, snapshot });
    worker.receive(
      type === "snapshot"
        ? { type, loadId: first.loadId, snapshot }
        : { type, loadId: first.loadId, diagnostic },
    );
    expect(coordinator.loading).toBe(true);
    expect(getState().snapshot).toBeNull();
    worker.receive({ type: "snapshot", loadId: second.loadId, snapshot });
    expect(coordinator.loading).toBe(false);
    expect(getState().snapshot).toBe(snapshot);
    worker.receive({ type: "fault", loadId: first.loadId, diagnostic });
    expect(getState().diagnostic).toBeNull();
    coordinator.dispose();
  },
);

it("retries retained restoration after failed loads and leaves the stale monitor hidden through reset", () => {
  const { worker, coordinator, load, getState } = setup(records);
  const first = load();
  expect(first.retentive).toEqual(records);
  worker.receive({ type: "fault", loadId: first.loadId, diagnostic });
  expect(coordinator.loading).toBe(false);
  coordinator.send({ type: "warmRestart" });
  worker.receive({ type: "snapshot", snapshot });
  expect(getState().snapshot).toBeNull();
  expect(getState().diagnostic).toBeNull();
  const retry = load();
  expect(retry.retentive).toEqual(records);
  worker.receive({ type: "snapshot", loadId: retry.loadId, snapshot });
  expect(load()).not.toHaveProperty("retentive");
  coordinator.dispose();
});

it("blocks retained events from the old project until its replacement can load", () => {
  const { worker, coordinator, load, getState } = setup(records);
  coordinator.replaceProject();
  worker.receive({ type: "retentive", records: [] });
  expect(getState().retentive).toBe(records);
  const replacement = load();
  expect(replacement).not.toHaveProperty("retentive");
  worker.receive({ type: "retentive", records: [] });
  expect(getState().retentive).toEqual([]);
  coordinator.dispose();
});

it("maps renamed and edited source back to loaded code until reload", () => {
  const { worker, coordinator, load, update, apply, getState } = setup();
  update({ breakpoints: { MAIN: [3] }, instanceChoices: { MAIN: "mainInstance" } });
  const first = load();
  worker.receive({ type: "snapshot", loadId: first.loadId, snapshot });
  apply(editSource(getState(), "// inserted\n" + main.replace("Main", "Renamed"))!);
  expect(coordinator.runtimeSource()).toEqual({
    pou: "Main",
    choices: { MAIN: "mainInstance", RENAMED: "mainInstance" },
  });
  expect(coordinator.breakpointMarkers()).toEqual([{ line: 4, active: true }]);
  expect(worker.sent.filter((message) => message.type === "setBreakpoints")).toHaveLength(1);
  coordinator.applySourceMappings({ removed: "RENAMED" });
  coordinator.synchronize();
  expect(coordinator.runtimeSource().pou).toBe("Renamed");
  expect(coordinator.breakpointMarkers()).toEqual([{ line: 4, active: false }]);
  expect(worker.sent.at(-1)).toEqual({ type: "setBreakpoints", breakpoints: [] });
  coordinator.dispose();
});

it("selects a halted loaded frame through its renamed editor source and remembers the instance", () => {
  const { worker, coordinator, load, apply, getState } = setup();
  const first = load();
  worker.receive({ type: "snapshot", loadId: first.loadId, snapshot });
  apply(editSource(getState(), main.replace("Main", "Renamed"))!);
  worker.receive({ type: "state", state: "HALT" });
  worker.receive({
    type: "halted",
    operatingState: "RUN",
    task: "Cyclic",
    frames: [
      {
        kind: "PROGRAM",
        pou: "Main",
        instance: "mainInstance",
        span: { line: 3, column: 1, endLine: 3, endColumn: 12 },
        values: [],
        annotations: {},
      },
    ],
  });
  expect(getState().selection).toEqual({ kind: "pou", index: 0 });
  expect(getState().instanceChoices).toEqual({ RENAMED: "mainInstance" });
  expect(getState().source).toContain("PROGRAM Renamed");
  coordinator.dispose();
});

it.each(["error", "close"] as const)(
  "stops protocol effects after %s and unsubscribes on disposal",
  (event) => {
    const { worker, client, coordinator, load, update, getState } = setup();
    const first = load();
    worker.receive({ type: "snapshot", loadId: first.loadId, snapshot });
    if (event === "error") worker.dispatchEvent(new Event("error"));
    else client.dispose();
    const sent = worker.sent.length;
    update({ breakpoints: { MAIN: [3] } });
    coordinator.send({ type: "run" });
    expect(coordinator.load(getState().editorIr!)).toBe(false);
    expect(worker.sent).toHaveLength(sent);
    expect(getState().connection).toBe(event === "error" ? "failed" : "closed");
    coordinator.dispose();
  },
);

it("unsubscribes from Worker events on disposal", () => {
  const { coordinator, worker, getState } = setup();
  const before = getState();
  coordinator.dispose();
  worker.receive({ type: "state", state: "RUN" });
  expect(getState()).toBe(before);
});

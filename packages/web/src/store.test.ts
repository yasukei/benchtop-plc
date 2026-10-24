import type { Diagnostic, RuntimeSnapshot } from "@benchtop-plc/core";
import { describe, expect, it, vi } from "vitest";
import { readProject, writeProject } from "@benchtop-plc/project";
import { en, ja } from "./catalog.js";
import { FakeWorker } from "./fake-worker.test-support.js";
import { RuntimeClient } from "./runtime-client.js";
import { demoSource } from "./demo.js";
import { createAppStore } from "./store.js";

const snapshot: RuntimeSnapshot = {
  scanCount: 1,
  lastExecutionTimeMs: 0.25,
  inputs: [false, false, false, false, false, false, false, false],
  outputs: [false, false, false, false, false, false, false, false],
  variables: [{ kind: "scalar", dataType: "DINT", value: 1 }],
  forced: [],
  annotations: {},
};
const fault: Diagnostic = { code: "runtime.division-by-zero", severity: "error", args: {} };

function setup() {
  const worker = new FakeWorker();
  const client = new RuntimeClient(worker);
  return { worker, client, store: createAppStore(client, demoSource) };
}

describe("app store", () => {
  it("stores a rejection separately from faults and keeps the connection and runtime state", () => {
    const { worker, store } = setup();
    worker.receive({ type: "state", state: "RUN" });
    worker.receive({ type: "snapshot", snapshot });
    const rejection = {
      type: "rejected",
      command: "write",
      diagnostic: {
        code: "runtime.write-input-mapped",
        severity: "error",
        args: { name: "input" },
      },
    } as const;
    worker.receive(rejection);
    expect(store.getSnapshot()).toMatchObject({
      connection: "connected",
      runtimeState: "RUN",
      snapshot,
      diagnostic: null,
      rejection,
    });
    worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 2 } });
    expect(store.getSnapshot().rejection).toEqual(rejection);
    expect(worker.terminated).toBe(false);
    store.send({ type: "stop" });
    expect(worker.sent).toEqual([{ type: "stop" }]);
    expect(store.getSnapshot().rejection).toBeNull();
    worker.receive({ type: "state", state: "FAULT" });
    worker.receive({ type: "fault", diagnostic: fault });
    worker.receive(rejection);
    expect(store.getSnapshot()).toMatchObject({
      runtimeState: "FAULT",
      diagnostic: fault,
      rejection,
    });
  });

  it("keeps stable snapshots and waits for confirmed runtime state", () => {
    const { worker, store } = setup();
    const initial = store.getSnapshot();
    expect(store.getSnapshot()).toBe(initial);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.send({ type: "run" });
    expect(store.getSnapshot().runtimeState).toBe("STOP");
    worker.receive({ type: "state", state: "RUN" });
    worker.receive({ type: "snapshot", snapshot });
    expect(store.getSnapshot()).toMatchObject({ runtimeState: "RUN", snapshot });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).not.toBe(initial);
    unsubscribe();
    worker.receive({ type: "state", state: "STOP" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("preserves a latched fault through emergency stop and clears it on a reset snapshot", () => {
    const { worker, store } = setup();
    worker.receive({ type: "state", state: "FAULT" });
    worker.receive({ type: "snapshot", snapshot });
    worker.receive({ type: "fault", diagnostic: fault });
    worker.receive({ type: "state", state: "ESTOP" });
    store.send({ type: "stop" });
    expect(store.getSnapshot().diagnostic).toEqual(fault);
    store.send({ type: "coldReset" });
    expect(store.getSnapshot().diagnostic).toEqual(fault);
    worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
    expect(store.getSnapshot()).toMatchObject({ runtimeState: "ESTOP", diagnostic: null });
  });

  it("validates cycle options and sends the selected cycle", () => {
    const { worker, store } = setup();
    store.send({ type: "setCycle", ms: 50 });
    expect(worker.sent).toEqual([{ type: "setCycle", ms: 50 }]);
    expect(store.getSnapshot().cycleMs).toBe(50);
    expect(() => store.send({ type: "setCycle", ms: 0 })).toThrow("cycle");
    expect(worker.sent).toHaveLength(1);
  });

  it.each(["error", "close"])("blocks commands after %s", (type) => {
    const { worker, client, store } = setup();
    if (type === "error") worker.dispatchEvent(new Event("error"));
    else client.dispose();
    store.send({ type: "run" });
    expect(worker.sent).toHaveLength(0);
    expect(store.getSnapshot().connection).toBe(type === "error" ? "failed" : "closed");
  });

  it("disconnects store listeners on disposal", () => {
    const { worker, store } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispose();
    worker.receive({ type: "state", state: "RUN" });
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot().runtimeState).toBe("STOP");
  });

  it("provides matching English and Japanese shell catalogs", () => {
    expect(Object.keys(ja).sort()).toEqual(Object.keys(en).sort());
    expect(Object.values(ja).every((text) => text.length > 0)).toBe(true);
  });
});

describe("editor state", () => {
  it("debounces compilation, clears stale diagnostics immediately and compiles the latest source", () => {
    vi.useFakeTimers();
    try {
      const { store } = setup();
      store.setSource("PROGRAM Test\nVAR x: INT; END_VAR\nmissing := 1;\nEND_PROGRAM");
      expect(store.getSnapshot().diagnostics).toEqual([]);
      vi.advanceTimersByTime(249);
      expect(store.getSnapshot().diagnostics).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(store.getSnapshot().diagnostics[0]).toMatchObject({
        code: "name.undeclared",
        span: { line: 3 },
      });
      store.setSource("PROGRAM Test END_PROGRAM");
      expect(store.getSnapshot().diagnostics).toEqual([]);
      vi.advanceTimersByTime(250);
      expect(store.getSnapshot().diagnostics).toEqual([]);
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("applies changes and cold-starts on RUN, waits for a load snapshot and resumes unchanged code", () => {
    const { store, worker } = setup();
    store.run();
    expect(worker.sent.map((message) => message.type)).toEqual(["load", "run"]);
    expect(store.getSnapshot().loadedSources).toBeNull();
    worker.receive({ type: "snapshot", snapshot });
    expect(store.getSnapshot().snapshot).toBeNull();
    worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
    expect(store.getSnapshot().loadedSources).toEqual([store.getSnapshot().source]);
    store.run();
    expect(worker.sent.map((message) => message.type)).toEqual(["load", "run", "run"]);
    worker.receive({ type: "state", state: "RUN" });
    store.setSource("PROGRAM New VAR x: INT := 7; END_VAR x := x + 1; END_PROGRAM");
    store.run();
    expect(worker.sent.map((message) => message.type)).toEqual([
      "load",
      "run",
      "run",
      "load",
      "run",
    ]);
    expect(store.getSnapshot().snapshot).toBeNull();
    worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
    expect(store.getSnapshot().loadedSources).toEqual([store.getSnapshot().source]);
    store.dispose();
  });
  it("clears a debug rejection when RUN applies changes or resumes the loaded source", () => {
    const { store, worker } = setup();
    const rejection = {
      type: "rejected",
      command: "force",
      diagnostic: {
        code: "runtime.debug-target",
        severity: "error",
        args: {},
      },
    } as const;
    worker.receive(rejection);
    store.run();
    expect(store.getSnapshot().rejection).toBeNull();
    worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
    worker.receive(rejection);
    store.run();
    expect(store.getSnapshot().rejection).toBeNull();
    store.dispose();
  });
  it("compiles synchronously on RUN and never sends invalid code or restarts a fault or E-STOP", () => {
    const { store, worker } = setup();
    store.setSource("PROGRAM Bad missing := 1; END_PROGRAM");
    store.run();
    expect(store.getSnapshot().diagnostics[0]?.code).toBe("name.undeclared");
    expect(worker.sent).toEqual([]);
    store.setSource("PROGRAM Good END_PROGRAM");
    for (const state of ["ESTOP", "FAULT"] as const) {
      worker.receive({ type: "state", state });
      store.run();
      expect(worker.sent).toEqual([]);
    }
    store.dispose();
  });
  it("cancels pending compile work on disposal", () => {
    vi.useFakeTimers();
    try {
      const { store } = setup();
      store.setSource("invalid");
      const listener = vi.fn();
      store.subscribe(listener);
      store.dispose();
      vi.runAllTimers();
      expect(listener).not.toHaveBeenCalled();
      expect(store.getSnapshot().diagnostics).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("latches emergency stop locally, blocks RUN, and requires explicit RUN after release", () => {
  const { store, worker } = setup();
  store.setEmergency(true);
  store.run();
  expect(worker.sent).toEqual([{ type: "estop", active: true }]);
  expect(store.getSnapshot().emergencyActive).toBe(true);
  store.setEmergency(false);
  expect(store.getSnapshot().emergencyReleased).toBe(true);
  expect(worker.sent.at(-1)).toEqual({ type: "estop", active: false });
  store.run();
  expect(worker.sent.at(-1)).toEqual({ type: "run" });
  expect(store.getSnapshot().emergencyReleased).toBe(false);
  store.dispose();
});

it("round trips source and panel through the project package and rejects loading during RUN", () => {
  const { store, worker } = setup();
  const part = {
    id: "lamp",
    kind: "led",
    label: "Lamp",
    x: 0.25,
    y: 0.75,
    bit: 1,
    color: "amber",
  } as const;
  store.setLayout([part]);
  const xml = store.saveProject()!;
  store.setLayout([]);
  expect(store.openProject(xml)).toBe(true);
  expect(store.getSnapshot().layout).toEqual([part]);
  expect(worker.sent).toMatchObject([
    { type: "load", ir: { resource: { tasks: [{ intervalMs: 10 }] } } },
  ]);
  worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
  worker.receive({ type: "state", state: "RUN" });
  const before = store.getSnapshot();
  expect(store.openProject(xml)).toBe(false);
  expect(store.getSnapshot()).toBe(before);
  worker.receive({ type: "state", state: "STOP" });
  const stopped = store.getSnapshot();
  expect(store.openProject("invalid")).toBe(false);
  expect(store.getSnapshot()).toBe(stopped);
  store.dispose();
});

it("restores the bundled example's source, panel and cycle through the project loader", () => {
  const { store, worker } = setup();
  store.setSource("PROGRAM Changed END_PROGRAM");
  store.setLayout([]);
  store.send({ type: "setCycle", ms: 100 });
  expect(store.restoreExample()).toBe(true);
  const restored = store.getSnapshot();
  expect(restored.source).toContain("PROGRAM Main");
  expect(restored.diagnostics).toEqual([]);
  expect(restored.layout).toHaveLength(7);
  expect(
    restored.layout.map(({ kind, label, bit, color }) => ({ kind, label, bit, color })),
  ).toEqual([
    { kind: "pushbutton", label: "START", bit: 0, color: "green" },
    { kind: "pushbutton", label: "STOP", bit: 1, color: "red" },
    { kind: "pushbutton", label: "RESET", bit: 2, color: "white" },
    { kind: "led", label: "Running", bit: 0, color: "green" },
    { kind: "led", label: "Lamp", bit: 1, color: "amber" },
    { kind: "led", label: "Alarm", bit: 2, color: "red" },
    { kind: "estop", label: "Emergency stop", bit: null, color: "red" },
  ]);
  expect(restored.project?.pous[0]).toBe(restored.source);
  expect(restored.cycleMs).toBe(10);
  expect(worker.sent.slice(-2)).toMatchObject([
    { type: "setCycle", ms: 100 },
    {
      type: "load",
      ir: {
        name: "Config",
        programs: [{ name: "Main" }],
        resource: { tasks: [{ intervalMs: 10 }] },
      },
    },
  ]);
  // Replacing a project cannot race an unacknowledged load.
  expect(store.restoreExample()).toBe(false);
  worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
  expect(store.getSnapshot().loadedSources).toEqual([restored.source]);
  store.dispose();
});

it.each(["RUN", "FAULT", "ESTOP", "emergency", "disconnected"] as const)(
  "blocks restoring the example while %s without changing the current project",
  (condition) => {
    const { store, worker } = setup();
    if (condition === "emergency") store.setEmergency(true);
    else if (condition === "disconnected") worker.dispatchEvent(new Event("error"));
    else worker.receive({ type: "state", state: condition });
    const before = store.getSnapshot();
    const sent = worker.sent.length;
    expect(store.restoreExample()).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    expect(worker.sent).toHaveLength(sent);
    store.dispose();
  },
);

it("opens and resaves semantic errors without loading them into the runtime", () => {
  const { worker, store } = setup();
  const source = "PROGRAM Main VAR x : INT; END_VAR x := Missing(1); END_PROGRAM";
  store.setSource(source);
  const xml = store.saveProject()!;
  expect(xml).toBeTruthy();
  worker.sent.length = 0;
  expect(store.openProject(xml)).toBe(true);
  expect(store.getSnapshot().source).toBe(source);
  expect(
    store.getSnapshot().diagnostics.some((item) => item.code === "call.unknown-function"),
  ).toBe(true);
  expect(worker.sent.some((message) => message.type === "load")).toBe(false);
  expect(readProject(store.saveProject()!)).toEqual(readProject(xml));
  store.dispose();
});

it("invalidates applied code when opening unchanged main text with a removed function", () => {
  const { worker, store } = setup();
  const main = "PROGRAM Main VAR x : INT; END_VAR x := F(); END_PROGRAM";
  const fn = "FUNCTION F : INT F := 1; END_FUNCTION";
  const metadata = readProject(store.saveProject()!).value!;
  const xml = (pous: string[]) => writeProject({ ...metadata, pous }).value!;
  expect(store.openProject(xml([main, fn]))).toBe(true);
  worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
  expect(store.getSnapshot().loadedSources).toEqual([main, fn]);
  expect(store.openProject(xml([main]))).toBe(true);
  expect(store.getSnapshot()).toMatchObject({ source: main, loadedSources: null, snapshot: null });
  worker.sent.length = 0;
  store.run();
  expect(worker.sent).toEqual([]);
  expect(store.getSnapshot().diagnostics.map((item) => item.code)).toContain(
    "call.unknown-function",
  );
  store.dispose();
});

it("switches POUs without reloading, reloads on function edits, and blocks Run after deletion", () => {
  const { store, worker } = setup();
  store.setSource("PROGRAM Main VAR result : INT; END_VAR result := F1(21); END_PROGRAM");
  store.addFunction();
  store.setSource("FUNCTION F1 : INT VAR_INPUT n : INT; END_VAR F1 := n * 2; END_FUNCTION");
  store.run();
  expect(worker.sent.map((message) => message.type)).toEqual(["load", "run"]);
  worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
  store.selectPou(0);
  store.run();
  expect(worker.sent.map((message) => message.type)).toEqual(["load", "run", "run"]);
  store.selectPou(1);
  store.setSource(store.getSnapshot().source.replace("n * 2", "n * 3"));
  store.run();
  expect(worker.sent.slice(-2).map((message) => message.type)).toEqual(["load", "run"]);
  worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
  store.deletePou(1);
  expect(store.getSnapshot().selectedPou).toBe(0);
  const count = worker.sent.length;
  store.run();
  expect(worker.sent).toHaveLength(count);
  expect(store.getSnapshot().diagnostics).toContainEqual(
    expect.objectContaining({ code: "call.unknown-function", sourceIndex: 0 }),
  );
  const xml = store.saveProject()!;
  expect(xml).toBeTruthy();
  expect(store.openProject(xml)).toBe(true);
  expect(store.getSnapshot().diagnostics).toContainEqual(
    expect.objectContaining({ code: "call.unknown-function" }),
  );
  store.dispose();
});

it("saves and reopens all three POU texts in order, and explains unparseable drafts", () => {
  const { store, worker } = setup();
  store.addFunction();
  store.addFunction();
  const sources = store.getSnapshot().pous.map((pou) => pou.source);
  const xml = store.saveProject()!;
  expect(readProject(xml).value!.pous).toEqual(sources);
  expect(store.openProject(xml)).toBe(true);
  worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
  expect(store.getSnapshot().pous.map((pou) => pou.source)).toEqual(sources);
  store.selectPou(2);
  store.setSource("FUNCTION");
  expect(store.getSnapshot().pous[2]!.name).toBe("F2");
  expect(store.saveProject()).toBeNull();
  expect(store.getSnapshot().saveDiagnostics.length).toBeGreaterThan(0);
  store.deletePou(0);
  expect(store.getSnapshot().pous).toHaveLength(3);
  store.dispose();
});

it("clears an earlier save failure when an open attempt fails", () => {
  const { store } = setup();
  store.setSource("PROGRAM");
  expect(store.saveProject()).toBeNull();
  expect(store.getSnapshot().saveDiagnostics.length).toBeGreaterThan(0);
  expect(store.openProject("invalid XML")).toBe(false);
  expect(store.getSnapshot().saveDiagnostics).toEqual([]);
  expect(store.getSnapshot().source).toBe("PROGRAM");
  store.dispose();
});

it("keeps empty projects saveable and creates a first POU on an editor change", () => {
  const { store, worker } = setup();
  const metadata = readProject(store.saveProject()!).value!;
  const empty = writeProject({ ...metadata, pous: [] }).value!;
  expect(store.openProject(empty)).toBe(true);
  expect(store.getSnapshot()).toMatchObject({ pous: [], selectedPou: 0, source: "" });
  expect(readProject(store.saveProject()!).value!.pous).toEqual([]);
  store.setSource("PROGRAM New END_PROGRAM");
  expect(store.getSnapshot().pous).toEqual([
    { name: "New", kind: "PROGRAM", source: "PROGRAM New END_PROGRAM" },
  ]);
  store.run();
  expect(worker.sent.slice(-2).map((message) => message.type)).toEqual(["load", "run"]);
  store.dispose();
});

it("edits and renames types, blocks run after deleting a used type, and still saves", () => {
  vi.useFakeTimers();
  const { store, worker } = setup();
  store.addDataType();
  expect(store.getSnapshot()).toMatchObject({
    selectedDataType: 0,
    source: expect.stringContaining("TYPE Type1"),
  });
  const type = "TYPE State : (Idle, Running, Done); END_TYPE";
  store.setSource(type);
  store.selectPou(0);
  const main = "PROGRAM Main VAR phase : State; END_VAR phase := State#Running; END_PROGRAM";
  store.setSource(main);
  store.run();
  expect(store.getSnapshot().diagnostics).toEqual([]);
  const load = worker.sent.find((message) => message.type === "load");
  expect(load?.type === "load" && load.ir.types?.[0]?.name).toBe("State");
  worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
  expect(store.getSnapshot().loadedDataTypes).toEqual([type]);
  const loadedSources = store.getSnapshot().loadedSources;
  store.selectDataType(0);
  store.setSource("TYPE");
  vi.advanceTimersByTime(250);
  expect(store.getSnapshot().dataTypes[0]?.name).toBe("State");
  expect(store.getSnapshot().diagnostics).toContainEqual(
    expect.objectContaining({ sourceKind: "dataType", sourceIndex: 0 }),
  );
  expect(store.saveProject()).toBeNull();
  store.setSource(type);
  const xml = store.saveProject()!;
  expect(readProject(xml).value?.dataTypes).toEqual([type]);
  store.deleteDataType(0);
  expect(store.getSnapshot()).toMatchObject({ selectedDataType: null, source: main });
  expect(store.getSnapshot().diagnostics).toContainEqual(
    expect.objectContaining({ code: "decl.unknown-type", sourceIndex: 0 }),
  );
  expect(store.getSnapshot().loadedSources).toBe(loadedSources);
  expect(store.getSnapshot().loadedDataTypes).toEqual([type]);
  worker.sent.length = 0;
  store.run();
  expect(worker.sent).toEqual([]);
  const missing = store.saveProject()!;
  expect(readProject(missing).value).toMatchObject({ dataTypes: [], pous: [main] });
  expect(store.openProject(missing)).toBe(true);
  expect(store.getSnapshot().diagnostics.length).toBeGreaterThan(0);
  expect(worker.sent.filter((message) => message.type === "load")).toEqual([]);
  store.dispose();
  vi.useRealTimers();
});

it("reloads when only type text changes and preserves selection across list operations", () => {
  const { store, worker } = setup();
  store.addDataType();
  store.addDataType();
  store.addDataType();
  store.deleteDataType(0);
  expect(store.getSnapshot()).toMatchObject({
    selectedDataType: 1,
    source: expect.stringContaining("TYPE Type3"),
  });
  store.deleteDataType(1);
  expect(store.getSnapshot()).toMatchObject({
    selectedDataType: 0,
    source: expect.stringContaining("TYPE Type2"),
  });
  store.addFunction();
  expect(store.getSnapshot().selectedDataType).toBeNull();
  store.selectDataType(0);
  store.deletePou(1);
  expect(store.getSnapshot().source).toContain("TYPE Type2");
  store.selectPou(0);
  store.deleteDataType(99);
  expect(store.getSnapshot().selectedDataType).toBeNull();
  store.loadEditor();
  worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
  worker.sent.length = 0;
  store.selectDataType(0);
  store.setSource("TYPE Type2 : (First, Second); END_TYPE");
  store.run();
  expect(worker.sent.map((message) => message.type)).toEqual(["load", "run"]);
  expect(store.getSnapshot().loadedDataTypes).toEqual([expect.stringContaining("Idle")]);
  worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
  expect(store.getSnapshot().loadedDataTypes).toEqual(["TYPE Type2 : (First, Second); END_TYPE"]);
  store.dispose();
});

it.each([false, true])(
  "opens and saves configuration sources with multiple tasks=%s",
  (multiple) => {
    const { worker, store } = setup();
    const project = readProject(store.saveProject()!).value!;
    const configurationSource = `CONFIGURATION Plant RESOURCE Station ON Cpu
TASK Fast (INTERVAL := T#200ms, PRIORITY := 0);
${multiple ? "TASK Slow (INTERVAL := T#100ms, PRIORITY := 1);" : ""}
PROGRAM A WITH Fast : BenchDemo;
PROGRAM B WITH Fast : BenchDemo;
END_RESOURCE END_CONFIGURATION`;
    project.configurationSource = configurationSource;
    expect(store.openProject(writeProject(project).value!)).toBe(true);
    expect(store.getSnapshot().project?.configurationSource).toBe(configurationSource);
    if (multiple) {
      expect(store.getSnapshot().diagnostics).toContainEqual(
        expect.objectContaining({ code: "config.task-count", sourceKind: "configuration" }),
      );
      expect(worker.sent.some((message) => message.type === "load")).toBe(false);
    } else {
      const load = worker.sent.find((message) => message.type === "load");
      expect(load).toMatchObject({
        type: "load",
        ir: {
          explicit: true,
          resource: { tasks: [{ intervalMs: 200 }], programs: [{ name: "A" }, { name: "B" }] },
        },
      });
      const sent = worker.sent.length;
      store.send({ type: "setCycle", ms: 50 });
      expect(worker.sent).toHaveLength(sent);
    }
    expect(readProject(store.saveProject()!).value?.configurationSource).toBe(configurationSource);
    store.dispose();
  },
);

it("adds one configuration, edits it independently, and applies its exact IR after acknowledgment", () => {
  vi.useFakeTimers();
  const { store, worker } = setup();
  store.run();
  worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
  const implicitIr = store.getSnapshot().loadedIr;
  store.addConfiguration();
  const template = store.getSnapshot().configuration!;
  expect(template.source).toContain("PROGRAM mainInstance WITH Cyclic : BenchDemo;");
  store.addConfiguration();
  expect(store.getSnapshot().configuration).toBe(template);
  store.setSource(template.source.replace("mainInstance", "Second").replace("Config", "Plant"));
  expect(store.getSnapshot().configuration?.name).toBe("Plant");
  expect(store.getSnapshot().loadedIr).toBe(implicitIr);
  store.run();
  expect(worker.sent.at(-2)).toMatchObject({
    type: "load",
    ir: { explicit: true, resource: { programs: [{ name: "Second" }] } },
  });
  // Editing again before acknowledgment must not change what the monitor receives.
  store.setSource("CONFIGURATION");
  worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
  expect(store.getSnapshot().loadedIr?.resource.programs[0]?.name).toBe("Second");
  expect(store.getSnapshot().loadedConfigurationSource).toContain("CONFIGURATION Plant");
  vi.advanceTimersByTime(250);
  expect(store.getSnapshot().configuration?.name).toBe("Plant");
  expect(store.getSnapshot().diagnostics).toContainEqual(
    expect.objectContaining({ sourceKind: "configuration", sourceIndex: 0 }),
  );
  const sent = worker.sent.length;
  store.run();
  expect(worker.sent).toHaveLength(sent);
  expect(store.saveProject()).toBeNull();
  store.selectPou(0);
  expect(store.getSnapshot().selectedConfiguration).toBe(false);
  expect(store.getSnapshot().source).toContain("PROGRAM BenchDemo");
  store.selectConfiguration();
  expect(store.getSnapshot().source).toBe("CONFIGURATION");
  store.addDataType();
  expect(store.getSnapshot().selectedConfiguration).toBe(false);
  store.selectConfiguration();
  store.deleteDataType(0);
  expect(store.getSnapshot().source).toBe("CONFIGURATION");
  store.addFunction();
  expect(store.getSnapshot().selectedConfiguration).toBe(false);
  store.selectConfiguration();
  store.deletePou(1);
  expect(store.getSnapshot().source).toBe("CONFIGURATION");
  store.dispose();
  vi.useRealTimers();
});

it("deletes an imported configuration and restores implicit names, cycle control and XML", () => {
  const { store, worker } = setup();
  const original = readProject(store.saveProject()!).value!;
  const configurationSource = `CONFIGURATION Plant RESOURCE Station ON BENCHTOP
TASK Fast (INTERVAL := T#200ms, PRIORITY := 0);
PROGRAM A WITH Fast : BenchDemo;
PROGRAM B WITH Fast : BenchDemo;
END_RESOURCE END_CONFIGURATION`;
  expect(store.openProject(writeProject({ ...original, configurationSource }).value!)).toBe(true);
  worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
  store.selectConfiguration();
  store.deleteConfiguration();
  expect(store.getSnapshot()).toMatchObject({
    configuration: null,
    selectedConfiguration: false,
    source: original.pous[0],
  });
  expect(store.getSnapshot().diagnostics).toEqual([]);
  store.send({ type: "setCycle", ms: 50 });
  expect(store.getSnapshot().cycleMs).toBe(50);
  expect(worker.sent.at(-1)?.type).toBe("load");
  const saved = readProject(store.saveProject()!).value!;
  expect(saved.configurationSource).toBeUndefined();
  expect(saved.task.interval).toBe("PT0.05S");
  store.run();
  expect(worker.sent.at(-2)).toMatchObject({
    type: "load",
    ir: {
      explicit: false,
      resource: {
        tasks: [{ intervalMs: 50 }],
        programs: [{ name: original.instance?.name ?? "mainInstance" }],
      },
    },
  });
  worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
  store.send({ type: "setCycle", ms: 20 });
  expect(worker.sent.at(-1)).toEqual({ type: "setCycle", ms: 20 });
  store.dispose();
});

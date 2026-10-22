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
    expect(store.getSnapshot().loadedSource).toBeNull();
    worker.receive({ type: "snapshot", snapshot });
    expect(store.getSnapshot().snapshot).toBeNull();
    worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
    expect(store.getSnapshot().loadedSource).toBe(store.getSnapshot().source);
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
    expect(store.getSnapshot().loadedSource).toBe(store.getSnapshot().source);
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
  expect(worker.sent.map((message) => message.type)).toEqual(["setCycle", "load"]);
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
    { type: "setCycle", ms: 10 },
    { type: "load", ir: { name: "Main" } },
  ]);
  // Replacing a project cannot race an unacknowledged load.
  expect(store.restoreExample()).toBe(false);
  worker.receive({ type: "snapshot", snapshot: { ...snapshot, scanCount: 0 } });
  expect(store.getSnapshot().loadedSource).toBe(restored.source);
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
  expect(store.getSnapshot().loadedSource).toBe(main);
  expect(store.openProject(xml([main]))).toBe(true);
  expect(store.getSnapshot()).toMatchObject({ source: main, loadedSource: null, snapshot: null });
  worker.sent.length = 0;
  store.run();
  expect(worker.sent).toEqual([]);
  expect(store.getSnapshot().diagnostics.map((item) => item.code)).toContain(
    "call.unknown-function",
  );
  store.dispose();
});

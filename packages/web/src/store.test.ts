import type { Diagnostic, RuntimeSnapshot } from "@benchtop-plc/core";
import { describe, expect, it, vi } from "vitest";
import { en, ja } from "./catalog.js";
import { FakeWorker } from "./fake-worker.test-support.js";
import { RuntimeClient } from "./runtime-client.js";
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
  return { worker, client, store: createAppStore(client) };
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

  it("stores theme changes outside React without sending runtime commands", () => {
    const { worker, store } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setTheme("dark");
    expect(store.getSnapshot().theme).toBe("dark");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(worker.sent).toEqual([]);
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

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

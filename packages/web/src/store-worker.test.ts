import type { RetentiveRecord } from "@benchtop-plc/core";
import { VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";
import { expect, it } from "vitest";
import { createAutosave, readAutosave, type SavedWork } from "./autosave.js";
import { FakeWorker } from "./fake-worker.test-support.js";
import { createPous } from "./pous.js";
import { RuntimeClient } from "./runtime-client.js";
import { createAppStore } from "./store.js";
import { createWorkerHost } from "./worker-host.js";

const source = "PROGRAM Main VAR RETAIN n : DINT := 1; END_VAR END_PROGRAM";
const records: RetentiveRecord[] = [
  {
    kind: "leaf",
    path: "mainInstance.n",
    dataType: '{"TYPE":"DINT"}',
    value: { dataType: "DINT", value: 777 },
  },
];

function setup(retentive?: RetentiveRecord[]) {
  const initial: SavedWork = {
    pous: createPous([source]),
    selectedPou: 0,
    dataTypes: [],
    selectedDataType: null,
    configuration: null,
    selectedConfiguration: false,
    layout: [],
    project: null,
    cycleMs: 10,
    ...(retentive === undefined ? {} : { retentive }),
  };
  const worker = new FakeWorker();
  const clock = new VirtualClock();
  const ticker = new VirtualTicker(clock);
  let failCancellation = false;
  const host = createWorkerHost(
    clock,
    {
      start(ms, tick) {
        const cancel = ticker.start(ms, tick);
        return () => {
          cancel();
          if (failCancellation) {
            failCancellation = false;
            throw new Error("Injected ticker cancellation error");
          }
        };
      },
    },
    (event) => worker.receive(event),
  );
  const store = createAppStore(new RuntimeClient(worker), initial);
  let handled = 0;
  // Drain commands after the UI finishes queuing them, as a real Worker would.
  const flush = (failNextLoad = false) => {
    while (handled < worker.sent.length) {
      const command = structuredClone(worker.sent[handled++]!);
      if (command.type === "load" && failNextLoad) {
        failNextLoad = false;
        const variable = command.ir.variables[0]!;
        if (variable.kind !== "scalar") throw new Error("Expected a scalar fixture");
        variable.initialValue = "invalid integer";
      }
      host.handle(command);
    }
  };
  return {
    store,
    worker,
    flush,
    initial,
    clock,
    failNextCancellation: () => {
      failCancellation = true;
    },
    dispose: () => {
      store.dispose();
      host.dispose();
    },
  };
}

it("preserves autosaved retained values across failed loads and restores them on retry only", () => {
  const { store, worker, flush, initial, dispose } = setup(records);
  let encoded = JSON.stringify({ version: 4, ...initial });
  const storage = {
    getItem: () => encoded,
    setItem: (_: string, value: string) => {
      encoded = value;
    },
  };
  const autosave = createAutosave(store, storage);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      store.run();
      expect(worker.sent.findLast((command) => command.type === "load")?.retentive).toEqual(
        records,
      );
      flush(true);
      expect(store.getSnapshot()).toMatchObject({
        connection: "connected",
        runtimeState: "FAULT",
        diagnostic: { code: "runtime.internal-error" },
        snapshot: null,
        retentive: records,
      });
      expect(readAutosave(storage)?.retentive).toEqual(records);
      store.send({ type: "warmRestart" });
      flush();
      expect(store.getSnapshot()).toMatchObject({ runtimeState: "STOP", diagnostic: null });
    }
    store.run();
    expect(worker.sent.findLast((command) => command.type === "load")?.retentive).toEqual(records);
    flush();
    expect(store.getSnapshot()).toMatchObject({
      runtimeState: "RUN",
      snapshot: { variables: [{ value: 777 }] },
      retentive: records,
    });
    expect(readAutosave(storage)?.retentive).toEqual(records);
    store.loadEditor();
    expect(worker.sent.findLast((command) => command.type === "load")).not.toHaveProperty(
      "retentive",
    );
    flush();
    expect(store.getSnapshot().snapshot?.variables[0]).toMatchObject({ value: 1 });
  } finally {
    autosave.dispose();
    dispose();
  }
});

it.each(["warmRestart", "coldReset"] as const)(
  "acknowledges a failed load with %s while keeping the old monitor hidden",
  (command) => {
    const { store, flush, dispose } = setup();
    try {
      store.loadEditor();
      flush();
      expect(store.getSnapshot().snapshot?.variables[0]).toMatchObject({ value: 1 });
      store.setSource(source.replace(":= 1", ":= 10"));
      store.run();
      flush(true);
      expect(store.getSnapshot().diagnostic?.code).toBe("runtime.internal-error");
      store.send({ type: command });
      flush();
      expect(store.getSnapshot()).toMatchObject({
        runtimeState: "STOP",
        connection: "connected",
        diagnostic: null,
        snapshot: null,
        loadedIr: undefined,
      });
      store.run();
      flush();
      expect(store.getSnapshot()).toMatchObject({
        runtimeState: "RUN",
        diagnostic: null,
        snapshot: { variables: [{ value: 10 }] },
      });
    } finally {
      dispose();
    }
  },
);

it("does not carry a failed autosave restoration into a replacement project", () => {
  const { store, worker, flush, dispose } = setup(records);
  try {
    store.run();
    flush(true);
    store.send({ type: "coldReset" });
    flush();
    const xml = store.saveProject()!;
    expect(store.openProject(xml)).toBe(true);
    expect(worker.sent.findLast((command) => command.type === "load")).not.toHaveProperty(
      "retentive",
    );
    flush();
    expect(store.getSnapshot().snapshot?.variables[0]).toMatchObject({ value: 1 });
  } finally {
    dispose();
  }
});

it("completes an internally failed load, clears its fault and runs a replacement without disconnecting", () => {
  const { store, worker, flush, clock, failNextCancellation, dispose } = setup();
  try {
    store.run();
    flush();
    expect(store.getSnapshot().runtimeState).toBe("RUN");
    failNextCancellation();
    store.setSource(source.replace(":= 1", ":= 10"));
    store.loadEditor();
    flush();
    expect(store.getSnapshot()).toMatchObject({
      connection: "connected",
      runtimeState: "FAULT",
      diagnostic: { code: "runtime.internal-error" },
      snapshot: null,
      loadedIr: undefined,
    });
    expect(worker.terminated).toBe(false);
    store.send({ type: "warmRestart" });
    flush();
    expect(store.getSnapshot()).toMatchObject({
      runtimeState: "STOP",
      diagnostic: null,
      snapshot: null,
    });
    store.setSource("PROGRAM Replacement VAR n : INT := 42; END_VAR n := n + 1; END_PROGRAM");
    store.run();
    flush();
    clock.advance(10);
    expect(store.getSnapshot()).toMatchObject({
      connection: "connected",
      runtimeState: "RUN",
      diagnostic: null,
      snapshot: { scanCount: 1, variables: [{ value: 43 }] },
    });
    expect(worker.terminated).toBe(false);
  } finally {
    dispose();
  }
});

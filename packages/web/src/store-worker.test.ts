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
  const host = createWorkerHost(clock, new VirtualTicker(clock), (event) => worker.receive(event));
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
        runtimeState: "STOP",
        diagnostic: { code: "runtime.load-failed" },
        snapshot: null,
        retentive: records,
      });
      expect(readAutosave(storage)?.retentive).toEqual(records);
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
      expect(store.getSnapshot().diagnostic?.code).toBe("runtime.load-failed");
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

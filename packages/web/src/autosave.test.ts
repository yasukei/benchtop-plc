import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autosaveStorageKey,
  retentiveStorageKey,
  createAutosave,
  readAutosave,
  type SavedWork,
} from "./autosave.js";
import { createPous, pouKinds } from "./pous.js";
import { browserStorage } from "./browser-storage.js";
import { FakeWorker } from "./fake-worker.test-support.js";
import { RuntimeClient } from "./runtime-client.js";
import { createAppStore } from "./store.js";
import blinkProjectXml from "../../../examples/blink/project.xml?raw";

function setup() {
  const worker = new FakeWorker();
  const store = createAppStore(new RuntimeClient(worker));
  store.openProject(blinkProjectXml);
  const values = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key = autosaveStorageKey) => values.get(key) ?? null),
    setItem: vi.fn((key: string, next: string) => {
      values.set(key, next);
    }),
  };
  return { store, worker, storage };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const retained = [
  {
    kind: "leaf" as const,
    path: "mainInstance.kept",
    dataType: '{"TYPE":"LINT"}',
    value: { dataType: "LINT" as const, value: "9223372036854775807" },
  },
  {
    kind: "block" as const,
    path: "mainInstance.ctr",
    blockType: "CTU" as const,
    inputs: [
      { dataType: "BOOL" as const, value: true },
      { dataType: "BOOL" as const, value: false },
      { dataType: "INT" as const, value: 10 },
    ],
    outputs: [
      { dataType: "BOOL" as const, value: false },
      { dataType: "INT" as const, value: 1 },
    ],
    state: { previous: true, optional: null },
  },
];

it("writes retained changes without rewriting work or moving an edit's save deadline", () => {
  vi.useFakeTimers();
  const { store, worker, storage } = setup();
  const autosave = createAutosave(store, storage);
  store.setSource("saved draft");
  autosave.flush();
  const original = storage.getItem();
  storage.setItem.mockClear();
  worker.receive({ type: "retentive", records: retained });
  expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
    retentiveStorageKey,
    JSON.stringify(retained),
  );
  expect(storage.getItem()).toBe(original);
  store.setSource("pending draft");
  vi.advanceTimersByTime(400);
  worker.receive({ type: "retentive", records: [] });
  expect(storage.getItem()).toBe(original);
  vi.advanceTimersByTime(100);
  expect(readAutosave(storage)).toMatchObject({
    pous: [{ source: "pending draft" }],
    retentive: [],
  });
  expect(storage.setItem.mock.calls.map(([key]) => key)).toEqual([
    retentiveStorageKey,
    retentiveStorageKey,
    autosaveStorageKey,
  ]);
  autosave.dispose();
  store.dispose();
});

it("migrates embedded retained records on first read and uses newer separate records thereafter", () => {
  const { store, storage } = setup();
  const legacy = JSON.stringify({ version: 4, ...store.getSnapshot(), retentive: retained });
  storage.setItem(autosaveStorageKey, legacy);
  storage.setItem.mockClear();
  expect(readAutosave(storage)?.retentive).toEqual(retained);
  expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
    retentiveStorageKey,
    JSON.stringify(retained),
  );
  expect(storage.getItem()).toBe(legacy);
  storage.setItem.mockClear();
  expect(readAutosave(storage)?.retentive).toEqual(retained);
  expect(storage.setItem).not.toHaveBeenCalled();
  storage.setItem(retentiveStorageKey, "[]");
  expect(readAutosave(storage)?.retentive).toEqual([]);
  storage.setItem(retentiveStorageKey, "null");
  expect(readAutosave(storage)?.retentive).toBeUndefined();
  store.dispose();
});

describe.each(["embedded", "separate"])("validates %s retained data", (location) => {
  it.each([
    null,
    {},
    [null],
    [42],
    [{}],
    [{ ...retained[0], kind: "unknown" }],
    [{ ...retained[0], path: 42 }],
    [{ ...retained[0], dataType: null }],
    [{ ...retained[0], value: null }],
    [{ ...retained[0], value: { dataType: "UNKNOWN", value: 1 } }],
    [{ ...retained[0], value: { dataType: "INT", value: 32768 } }],
    [{ ...retained[0], value: { dataType: "BOOL", value: 1 } }],
    [{ ...retained[0], value: { dataType: "LINT", value: "01" } }],
    [{ ...retained[1], blockType: "UNKNOWN" }],
    [{ ...retained[1], inputs: null }],
    [{ ...retained[1], inputs: [{}] }],
    [{ ...retained[1], outputs: [{}] }],
    [{ ...retained[1], state: [] }],
    [{ ...retained[1], state: { previous: 1 } }],
  ])("ignores malformed retained data %j while preserving editable work", (invalid) => {
    const { store, storage } = setup();
    storage.setItem(
      autosaveStorageKey,
      JSON.stringify({
        version: 4,
        ...store.getSnapshot(),
        retentive: location === "embedded" ? invalid : retained,
      }),
    );
    if (location === "separate") storage.setItem(retentiveStorageKey, JSON.stringify(invalid));
    const restored = readAutosave(storage);
    expect(restored?.pous).toEqual(store.getSnapshot().pous);
    expect(restored).not.toHaveProperty("retentive");
    store.dispose();
  });
});

it("preserves work when separate retention is unreadable, and legacy values when migration cannot write", () => {
  const { store, storage } = setup();
  storage.setItem(
    autosaveStorageKey,
    JSON.stringify({ version: 4, ...store.getSnapshot(), retentive: retained }),
  );
  storage.setItem.mockImplementation(() => {
    throw new Error("Full");
  });
  expect(readAutosave(storage)?.retentive).toEqual(retained);
  const getItem = storage.getItem.getMockImplementation()!;
  for (const raw of ["{", "[]"]) {
    storage.getItem.mockImplementation((key = autosaveStorageKey) => {
      if (key === retentiveStorageKey) {
        if (raw === "[]") throw new Error("Blocked");
        return raw;
      }
      return getItem(key);
    });
    expect(readAutosave(storage)?.pous).toEqual(store.getSnapshot().pous);
    expect(readAutosave(storage)).not.toHaveProperty("retentive");
  }
  store.dispose();
});

it("keeps legacy retention in edited work until the separate key can be written", () => {
  const { store, storage } = setup();
  storage.setItem(
    autosaveStorageKey,
    JSON.stringify({ version: 4, ...store.getSnapshot(), retentive: retained }),
  );
  const setItem = storage.setItem.getMockImplementation()!;
  storage.setItem.mockImplementation((key, value) => {
    if (key === retentiveStorageKey) throw new Error("Full");
    setItem(key, value);
  });
  const fresh = createAppStore(new RuntimeClient(new FakeWorker()), readAutosave(storage)!);
  const autosave = createAutosave(fresh, storage);
  fresh.setSource("PROGRAM unfinished");
  autosave.flush();
  expect(JSON.parse(storage.getItem()!).retentive).toEqual(retained);
  expect(readAutosave(storage)).toMatchObject({
    pous: [{ source: "PROGRAM unfinished" }],
    retentive: retained,
  });
  expect(fresh.getSnapshot().storageWarning).toBe(true);
  storage.setItem.mockImplementation(setItem);
  fresh.setSource("PROGRAM still_unfinished");
  autosave.flush();
  expect(JSON.parse(storage.getItem()!)).not.toHaveProperty("retentive");
  expect(readAutosave(storage)?.retentive).toEqual(retained);
  autosave.dispose();
  fresh.dispose();
  store.dispose();
});

describe("browser autosave", () => {
  it("debounces changes and round trips invalid editor text, layout, cycle and metadata", () => {
    vi.useFakeTimers();
    const { store, worker, storage } = setup();
    const autosave = createAutosave(store, storage);
    store.setSource("PROGRAM unfinished");
    vi.advanceTimersByTime(400);
    store.setLayout(store.getSnapshot().layout.map((part) => ({ ...part, x: 0.3 })));
    store.send({ type: "setCycle", ms: 50 });
    vi.advanceTimersByTime(499);
    expect(storage.setItem).not.toHaveBeenCalled();
    // Runtime and diagnostic notifications cannot reset the debounce deadline.
    worker.receive({ type: "state", state: "RUN" });
    vi.advanceTimersByTime(1);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const restored = readAutosave(storage)!;
    expect(restored).toEqual({
      dataTypes: [],
      selectedDataType: null,
      configuration: null,
      selectedConfiguration: false,
      pous: store.getSnapshot().pous,
      selectedPou: 0,
      layout: store.getSnapshot().layout,
      cycleMs: 50,
      project: store.getSnapshot().project,
    });
    expect(restored.project?.contentHeader.name).toBeTruthy();
    expect(Object.keys(JSON.parse(storage.getItem()!)).sort()).toEqual(
      [
        "version",
        "configuration",
        "selectedConfiguration",
        "pous",
        "selectedPou",
        "dataTypes",
        "selectedDataType",
        "layout",
        "cycleMs",
        "project",
      ].sort(),
    );
    const fresh = createAppStore(new RuntimeClient(new FakeWorker()), restored);
    expect(fresh.getSnapshot()).toMatchObject({
      source: restored.pous[restored.selectedPou]!.source,
      runtimeState: "STOP",
      snapshot: null,
      loadedSources: null,
      emergencyActive: false,
    });
    expect(fresh.getSnapshot().diagnostics.length).toBeGreaterThan(0);
    fresh.dispose();
    autosave.dispose();
    store.dispose();
  });

  it("flushes pending work before the deadline, stops on disposal and never saves runtime alone", () => {
    vi.useFakeTimers();
    const { store, worker, storage } = setup();
    const autosave = createAutosave(store, storage);
    worker.receive({ type: "state", state: "RUN" });
    vi.advanceTimersByTime(1000);
    expect(storage.setItem).not.toHaveBeenCalled();
    store.setSource("first edit");
    autosave.flush();
    expect(readAutosave(storage)?.pous[0]?.source).toBe("first edit");
    store.setSource("latest edit");
    autosave.dispose();
    expect(readAutosave(storage)?.pous[0]?.source).toBe("latest edit");
    store.setSource("after disposal");
    vi.runAllTimers();
    expect(storage.setItem).toHaveBeenCalledTimes(2);
    store.dispose();
  });

  it.each([
    "{",
    "null",
    "[]",
    "{}",
    { version: 2 },
    { layout: null },
    { layout: [{ id: "bad" }] },
    { cycleMs: 0 },
    { cycleMs: "10" },
    { source: 5 },
    { project: {} },
    { project: { fileHeader: {}, contentHeader: {}, task: null } },
  ])("falls back to the example for invalid saved data %j", async (invalid) => {
    const { store, storage } = setup();
    const state = store.getSnapshot();
    const raw =
      typeof invalid === "string"
        ? invalid
        : JSON.stringify({
            version: 1,
            source: state.source,
            layout: state.layout,
            cycleMs: state.cycleMs,
            project: state.project,
            ...invalid,
          });
    storage.setItem(autosaveStorageKey, raw);
    expect(readAutosave(storage)).toBeNull();
    // Same fallback path as browser startup, with the real bundled project.
    const fallback = createAppStore(
      new RuntimeClient(new FakeWorker()),
      readAutosave(storage) ?? "",
    );
    expect(await fallback.openExample("blink")).toBe(true);
    expect(fallback.getSnapshot()).toMatchObject({
      source: expect.stringContaining("PROGRAM Main"),
      layout: expect.any(Array),
      runtimeState: "STOP",
    });
    expect(fallback.getSnapshot().layout).toHaveLength(7);
    fallback.dispose();
    store.dispose();
  });

  it("accepts a record without project metadata and does not require the source to compile", () => {
    const work: SavedWork = {
      dataTypes: [],
      selectedDataType: null,
      configuration: null,
      selectedConfiguration: false,
      pous: createPous([""]),
      selectedPou: 0,
      layout: [],
      cycleMs: 20,
      project: null,
    };
    expect(
      readAutosave({ getItem: () => JSON.stringify({ version: 2, ...work }), setItem: vi.fn() }),
    ).toEqual(work);
  });

  it("tolerates missing storage, throwing reads/writes, and a throwing localStorage getter", () => {
    vi.useFakeTimers();
    const blocked = () => {
      throw new Error("Blocked");
    };
    vi.stubGlobal("window", {
      get localStorage() {
        return blocked();
      },
    });
    expect(browserStorage()).toBeUndefined();
    expect(readAutosave()).toBeNull();
    expect(readAutosave({ getItem: blocked, setItem: blocked })).toBeNull();
    const { store } = setup();
    const autosave = createAutosave(store, { getItem: blocked, setItem: blocked });
    store.setSource("unsaved edit");
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    const unavailable = createAutosave(store);
    store.setSource("another edit");
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    autosave.dispose();
    unavailable.dispose();
    store.dispose();
  });
});

it("migrates the single-program metadata of a 0.3.0 autosave", () => {
  const { store } = setup();
  const work = store.getSnapshot();
  const { pous, ...metadata } = work.project!;
  const legacy = { version: 1, ...work, project: { ...metadata, program: pous[0] } };
  const restored = readAutosave({ getItem: () => JSON.stringify(legacy), setItem: vi.fn() });
  expect(restored).toEqual({
    dataTypes: [],
    selectedDataType: null,
    configuration: null,
    selectedConfiguration: false,
    pous: work.pous,
    selectedPou: 0,
    layout: work.layout,
    cycleMs: work.cycleMs,
    project: work.project,
  });
  store.dispose();
});

it("preserves all draft texts, previous names and selection in version 4", () => {
  const { store, storage } = setup();
  const autosave = createAutosave(store, storage);
  store.addFunction();
  store.addFunction();
  store.setSource("FUNCTION");
  autosave.flush();
  const restored = readAutosave(storage)!;
  expect(restored.pous).toEqual(store.getSnapshot().pous);
  expect(restored.selectedPou).toBe(2);
  expect(restored.pous[2]).toMatchObject({ name: "F2", source: "FUNCTION", kind: "FUNCTION" });
  expect(JSON.parse(storage.getItem()!).version).toBe(4);
  autosave.dispose();
  store.dispose();
});

it("migrates the latest unparseable 0.3.0 program draft instead of stale metadata", () => {
  const { store, storage } = setup();
  const { pous, ...metadata } = store.getSnapshot().project!;
  storage.setItem(
    autosaveStorageKey,
    JSON.stringify({
      version: 1,
      source: "PROGRAM",
      layout: [],
      cycleMs: 10,
      project: { ...metadata, program: pous[0] },
    }),
  );
  const restored = readAutosave(storage)!;
  expect(restored.pous).toEqual([{ source: "PROGRAM", name: "Main", kind: "PROGRAM" }]);
  expect(restored.selectedPou).toBe(0);
  const fresh = createAppStore(new RuntimeClient(new FakeWorker()), restored);
  expect(fresh.getSnapshot().source).toBe("PROGRAM");
  expect(fresh.getSnapshot().diagnostics.length).toBeGreaterThan(0);
  fresh.dispose();
  store.dispose();
});

it.each([
  { pous: null },
  { pous: [{}] },
  { pous: [{ source: "draft", name: "F", kind: "OTHER" }] },
  { selectedPou: -1 },
  { selectedPou: 1 },
  { selectedPou: 0.5 },
  { selectedPou: "0" },
])("rejects invalid version 2 work %j", (invalid) => {
  const work: SavedWork = {
    dataTypes: [],
    selectedDataType: null,
    configuration: null,
    selectedConfiguration: false,
    pous: createPous(["PROGRAM Main END_PROGRAM"]),
    selectedPou: 0,
    layout: [],
    cycleMs: 10,
    project: null,
  };
  expect(
    readAutosave({
      getItem: () => JSON.stringify({ version: 2, ...work, ...invalid }),
      setItem: vi.fn(),
    }),
  ).toBeNull();
});

it("migrates version 1 multi-POU metadata without losing functions or the latest program edit", () => {
  const { store, storage } = setup();
  const fn = "FUNCTION F : INT F := 1; END_FUNCTION";
  const project = { ...store.getSnapshot().project!, pous: [fn, store.getSnapshot().source] };
  const source = "PROGRAM Renamed END_PROGRAM";
  storage.setItem(
    autosaveStorageKey,
    JSON.stringify({ version: 1, source, layout: [], cycleMs: 10, project }),
  );
  const restored = readAutosave(storage)!;
  expect(restored.pous.map((pou) => pou.source)).toEqual([fn, source]);
  expect(restored.pous[1]!.name).toBe("Renamed");
  expect(restored.selectedPou).toBe(1);
  store.dispose();
});

it("migrates project metadata without data types and rejects malformed type sources", () => {
  const { store, storage } = setup();
  const legacy = { ...store.getSnapshot().project! };
  Reflect.deleteProperty(legacy, "dataTypes");
  const work = {
    version: 2,
    pous: store.getSnapshot().pous,
    selectedPou: 0,
    layout: [],
    cycleMs: 10,
  };
  storage.setItem(autosaveStorageKey, JSON.stringify({ ...work, project: legacy }));
  expect(readAutosave(storage)?.project?.dataTypes).toEqual([]);
  for (const dataTypes of [null, "TYPE T : INT; END_TYPE", [42]]) {
    storage.setItem(
      autosaveStorageKey,
      JSON.stringify({ ...work, project: { ...legacy, dataTypes } }),
    );
    expect(readAutosave(storage)).toBeNull();
  }
  const dataTypes = ["TYPE State : (Idle, Running); END_TYPE"];
  storage.setItem(
    autosaveStorageKey,
    JSON.stringify({ ...work, project: { ...legacy, dataTypes } }),
  );
  expect(readAutosave(storage)?.project?.dataTypes).toEqual(dataTypes);
  expect(readAutosave(storage)?.dataTypes.map((type) => type.source)).toEqual(dataTypes);
  store.dispose();
});

it("restores 0.4.0 autosaves with all POUs, drafts and selection intact", () => {
  const pous = [
    { source: "FUNCTION", name: "F1", kind: "FUNCTION" },
    { source: "PROGRAM Main END_PROGRAM", name: "Main", kind: "PROGRAM" },
  ];
  const legacy = { version: 2, pous, selectedPou: 0, project: null, layout: [], cycleMs: 20 };
  const restored = readAutosave({ getItem: () => JSON.stringify(legacy), setItem: vi.fn() })!;
  expect(restored).toEqual({
    pous,
    selectedPou: 0,
    project: null,
    layout: [],
    cycleMs: 20,
    dataTypes: [],
    selectedDataType: null,
    configuration: null,
    selectedConfiguration: false,
  });
  const store = createAppStore(new RuntimeClient(new FakeWorker()), restored);
  expect(store.getSnapshot()).toMatchObject({ pous, selectedPou: 0, source: "FUNCTION" });
  store.dispose();
});

it("autosaves type drafts and previous names independently of project metadata", () => {
  const { store, storage } = setup();
  const autosave = createAutosave(store, storage);
  store.addDataType();
  store.setSource("TYPE State : (Idle, Running); END_TYPE");
  store.setSource("TYPE");
  autosave.flush();
  const restored = readAutosave(storage)!;
  expect(restored).toMatchObject({
    selectedDataType: 0,
    dataTypes: [{ source: "TYPE", name: "State", kind: "TYPE" }],
  });
  const fresh = createAppStore(new RuntimeClient(new FakeWorker()), restored);
  expect(fresh.getSnapshot()).toMatchObject({ source: "TYPE", selectedDataType: 0 });
  expect(fresh.getSnapshot().diagnostics).toContainEqual(
    expect.objectContaining({ sourceKind: "dataType", sourceIndex: 0 }),
  );
  store.selectPou(0);
  autosave.flush();
  expect(readAutosave(storage)?.selectedDataType).toBeNull();
  store.deleteDataType(0);
  autosave.flush();
  expect(readAutosave(storage)?.dataTypes).toEqual([]);
  fresh.dispose();
  autosave.dispose();
  store.dispose();
});

it.each([
  { dataTypes: null },
  { dataTypes: ["TYPE State : INT; END_TYPE"] },
  { dataTypes: [{ name: "State", source: "TYPE", kind: "PROGRAM" }] },
  { selectedDataType: -1 },
  { selectedDataType: 0 },
  { selectedDataType: 0.5 },
  { selectedDataType: "0" },
  { selectedDataType: undefined },
])("rejects malformed version 3 type state %j", (invalid) => {
  const work = {
    version: 3,
    pous: [],
    selectedPou: 0,
    dataTypes: [],
    selectedDataType: null,
    configuration: null,
    selectedConfiguration: false,
    project: null,
    layout: [],
    cycleMs: 10,
    ...invalid,
  };
  expect(readAutosave({ getItem: () => JSON.stringify(work), setItem: vi.fn() })).toBeNull();
});

it("preserves a configuration source through autosave without requiring compilation", () => {
  const { store, storage } = setup();
  const state = store.getSnapshot();
  const project = { ...state.project!, configurationSource: "CONFIGURATION unfinished" };
  storage.setItem(autosaveStorageKey, JSON.stringify({ version: 3, ...state, project }));
  const restored = readAutosave(storage)!;
  expect(restored.project?.configurationSource).toBe(project.configurationSource);
  const fresh = createAppStore(new RuntimeClient(new FakeWorker()), restored);
  expect(fresh.getSnapshot().diagnostics).toContainEqual(
    expect.objectContaining({ sourceKind: "configuration" }),
  );
  project.configurationSource = 42 as unknown as string;
  storage.setItem(autosaveStorageKey, JSON.stringify({ version: 3, ...state, project }));
  expect(readAutosave(storage)).toBeNull();
  fresh.dispose();
  store.dispose();
});

it("restores an unchanged 0.5.0 version 3 record including types, drafts and selection", () => {
  const legacy = {
    version: 3,
    pous: [{ source: "PROGRAM Main END_PROGRAM", name: "Main", kind: "PROGRAM" }],
    selectedPou: 0,
    dataTypes: [{ source: "TYPE", name: "Phase", kind: "TYPE" }],
    selectedDataType: 0,
    layout: [],
    cycleMs: 50,
    project: null,
  };
  const restored = readAutosave({ getItem: () => JSON.stringify(legacy), setItem: vi.fn() })!;
  const work = { ...legacy };
  Reflect.deleteProperty(work, "version");
  expect(restored).toEqual({ ...work, configuration: null, selectedConfiguration: false });
  const store = createAppStore(new RuntimeClient(new FakeWorker()), restored);
  expect(store.getSnapshot()).toMatchObject({
    source: "TYPE",
    runtimeState: "STOP",
    snapshot: null,
  });
  store.dispose();
});

it("autosaves configuration drafts, previous names, selection and deletion independently of metadata", () => {
  const { store, storage } = setup();
  const autosave = createAutosave(store, storage);
  store.addConfiguration();
  store.setSource(
    store.getSnapshot().source.replace("CONFIGURATION Config", "CONFIGURATION Plant"),
  );
  store.setSource("CONFIGURATION");
  autosave.flush();
  const restored = readAutosave(storage)!;
  expect(restored).toMatchObject({
    configuration: { source: "CONFIGURATION", name: "Plant" },
    selectedConfiguration: true,
  });
  const fresh = createAppStore(new RuntimeClient(new FakeWorker()), restored);
  expect(fresh.getSnapshot().source).toBe("CONFIGURATION");
  store.deleteConfiguration();
  autosave.flush();
  expect(readAutosave(storage)).toMatchObject({
    configuration: null,
    selectedConfiguration: false,
  });
  fresh.dispose();
  autosave.dispose();
  store.dispose();
});

it.each([
  { configuration: undefined },
  { configuration: {} },
  { configuration: { name: "Config", source: 42, kind: "CONFIGURATION" } },
  { selectedConfiguration: undefined },
  { selectedConfiguration: "true" },
  { selectedConfiguration: true },
])("rejects malformed version 4 configuration state %j", (invalid) => {
  const work = {
    version: 4,
    pous: [],
    selectedPou: 0,
    dataTypes: [],
    selectedDataType: null,
    configuration: null,
    selectedConfiguration: false,
    project: null,
    layout: [],
    cycleMs: 10,
    ...invalid,
  };
  expect(readAutosave({ getItem: () => JSON.stringify(work), setItem: vi.fn() })).toBeNull();
});

it("saves complete retained sets immediately, restores only on the first load, and warns if storage fails", () => {
  const { store, worker, storage } = setup();
  const autosave = createAutosave(store, storage);
  store.setSource(store.getSnapshot().source + "\n");
  autosave.flush();
  const records = [
    {
      kind: "leaf" as const,
      path: "mainInstance.COUNT",
      dataType: '"DINT"',
      value: { dataType: "DINT" as const, value: 42 },
    },
  ];
  worker.receive({ type: "retentive", records });
  expect(storage.setItem.mock.calls.map(([key]) => key)).toEqual([
    autosaveStorageKey,
    retentiveStorageKey,
  ]);
  expect(JSON.parse(storage.getItem()!)).not.toHaveProperty("retentive");
  expect(readAutosave(storage)?.retentive).toEqual(records);
  const freshWorker = new FakeWorker();
  const fresh = createAppStore(new RuntimeClient(freshWorker), readAutosave(storage)!);
  fresh.loadEditor();
  expect(freshWorker.sent.at(-2)).toMatchObject({ type: "load", retentive: records });
  fresh.loadEditor();
  expect(freshWorker.sent.at(-2)).not.toHaveProperty("retentive");
  worker.receive({ type: "retentiveRestored", skipped: ["mainInstance.old"] });
  expect(store.getSnapshot().retentiveSkipped).toEqual(["mainInstance.old"]);
  storage.setItem.mockImplementation(() => {
    throw new Error("Full");
  });
  worker.receive({ type: "retentive", records: [] });
  expect(store.getSnapshot().storageWarning).toBe(true);
  expect(store.getSnapshot().connection).toBe("connected");
  autosave.dispose();
});

it("keeps retained records while autosaved source fails compilation and restores when a program can load", () => {
  const { store, worker, storage } = setup();
  const autosave = createAutosave(store, storage);
  store.setSource("PROGRAM unfinished");
  worker.receive({ type: "retentive", records: [] });
  autosave.flush();
  const saved = readAutosave(storage)!;
  const freshWorker = new FakeWorker();
  const fresh = createAppStore(new RuntimeClient(freshWorker), saved);
  expect(fresh.loadEditor()).toBe(false);
  expect(freshWorker.sent).toEqual([]);
  fresh.setSource("PROGRAM P END_PROGRAM");
  expect(fresh.loadEditor()).toBe(true);
  expect(freshWorker.sent.at(-2)).toMatchObject({ type: "load", retentive: [] });
  autosave.dispose();
});

it("autosaves class drafts and restores their source kind", () => {
  vi.useFakeTimers();
  const { store, storage } = setup();
  const autosave = createAutosave(store, storage);
  store.addClass();
  store.setSource("CLASS Class1\nMETHOD PUBLIC Run\n");
  vi.advanceTimersByTime(500);
  expect(readAutosave(storage)?.pous.at(-1)).toMatchObject({
    kind: "CLASS",
    name: "Class1",
    source: "CLASS Class1\nMETHOD PUBLIC Run\n",
  });
  autosave.dispose();
});

it("round trips a workspace containing every POU kind, including a selected interface", () => {
  vi.useFakeTimers();
  const { store, storage } = setup();
  const autosave = createAutosave(store, storage);
  store.addFunction();
  store.addFunctionBlock();
  store.addClass();
  store.addInterface();
  const source = "INTERFACE IActuator\nMETHOD Start\nEND_METHOD\nEND_INTERFACE\n";
  store.setSource(source);
  vi.advanceTimersByTime(500);
  const state = store.getSnapshot();
  expect(new Set(state.pous.map((pou) => pou.kind))).toEqual(new Set(pouKinds));
  const saved = readAutosave(storage);
  expect(saved).toMatchObject({ pous: state.pous, selectedPou: state.selectedPou });
  const restored = createAppStore(new RuntimeClient(new FakeWorker()), saved!);
  expect(restored.getSnapshot()).toMatchObject({
    pous: state.pous,
    selectedPou: state.selectedPou,
    source,
  });
  autosave.dispose();
  restored.dispose();
  store.dispose();
});

it("autosaves per-source instance choices and restores them without adding project metadata", () => {
  vi.useFakeTimers();
  const { store, worker, storage } = setup();
  worker.receive({
    type: "snapshot",
    loadId: 1,
    snapshot: {
      scanCount: 0,
      tasks: [],
      lastExecutionTimeMs: 0,
      inputs: [],
      outputs: [],
      variables: [],
      forced: [],
      annotations: [],
    },
  });
  const autosave = createAutosave(store, storage);
  store.selectInstance("mainInstance");
  vi.advanceTimersByTime(500);
  const saved = readAutosave(storage)!;
  expect(saved.instanceChoices).toEqual({ MAIN: "mainInstance" });
  expect(saved.project).not.toHaveProperty("instanceChoices");
  const freshWorker = new FakeWorker();
  const fresh = createAppStore(new RuntimeClient(freshWorker), saved);
  expect(fresh.getSnapshot().instanceChoices).toEqual(saved.instanceChoices);
  fresh.loadEditor();
  freshWorker.receive({
    type: "snapshot",
    loadId: 1,
    snapshot: {
      scanCount: 0,
      tasks: [],
      lastExecutionTimeMs: 0,
      inputs: [],
      outputs: [],
      variables: [],
      forced: [],
      annotations: [],
    },
  });
  expect(freshWorker.sent.at(-1)).toEqual({
    type: "watchBodies",
    bodies: [{ pou: "Main", instance: "mainInstance" }],
  });
  autosave.dispose();
  store.dispose();
  fresh.dispose();
});

it("autosaves breakpoints per source and starts imported projects without them", () => {
  vi.useFakeTimers();
  const { store, storage, worker } = setup();
  worker.receive({
    type: "snapshot",
    loadId: 1,
    snapshot: {
      scanCount: 0,
      tasks: [],
      lastExecutionTimeMs: 0,
      inputs: [],
      outputs: [],
      variables: [],
      forced: [],
      annotations: [],
    },
  });
  const autosave = createAutosave(store, storage);
  store.toggleBreakpoint(1);
  vi.advanceTimersByTime(500);
  const saved = readAutosave(storage)!;
  expect(saved.breakpoints).toEqual({ [store.getSnapshot().pous[0]!.name.toUpperCase()]: [1] });
  const restored = createAppStore(new RuntimeClient(new FakeWorker()), saved);
  expect(restored.breakpointMarkers()).toEqual([{ line: 1, active: false }]);
  const xml = store.saveProject()!;
  expect(xml).not.toContain("breakpoints");
  expect(store.openProject(xml)).toBe(true);
  expect(store.breakpointMarkers()).toEqual([]);
  autosave.dispose();
  restored.dispose();
  store.dispose();
});

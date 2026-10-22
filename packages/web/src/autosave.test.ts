import { afterEach, describe, expect, it, vi } from "vitest";
import { autosaveStorageKey, createAutosave, readAutosave, type SavedWork } from "./autosave.js";
import { createPous } from "./pous.js";
import { browserStorage } from "./browser-storage.js";
import { FakeWorker } from "./fake-worker.test-support.js";
import { RuntimeClient } from "./runtime-client.js";
import { createAppStore } from "./store.js";

function setup() {
  const worker = new FakeWorker();
  const store = createAppStore(new RuntimeClient(worker));
  store.restoreExample();
  let value: string | null = null;
  const storage = {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_: string, next: string) => {
      value = next;
    }),
  };
  return { store, worker, storage };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
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
      pous: store.getSnapshot().pous,
      selectedPou: 0,
      layout: store.getSnapshot().layout,
      cycleMs: 50,
      project: store.getSnapshot().project,
    });
    expect(restored.project?.contentHeader.name).toBeTruthy();
    expect(Object.keys(JSON.parse(storage.getItem()!)).sort()).toEqual(
      ["version", "pous", "selectedPou", "layout", "cycleMs", "project"].sort(),
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
  ])("falls back to the example for invalid saved data %j", (invalid) => {
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
    expect(fallback.restoreExample()).toBe(true);
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
    pous: work.pous,
    selectedPou: 0,
    layout: work.layout,
    cycleMs: work.cycleMs,
    project: work.project,
  });
  store.dispose();
});

it("preserves all draft texts, previous names and selection in version 2", () => {
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
  expect(JSON.parse(storage.getItem()!).version).toBe(2);
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

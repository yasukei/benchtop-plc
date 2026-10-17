import { afterEach, describe, expect, it, vi } from "vitest";
import { autosaveStorageKey, createAutosave, readAutosave, type SavedWork } from "./autosave.js";
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
      source: "PROGRAM unfinished",
      layout: store.getSnapshot().layout,
      cycleMs: 50,
      project: store.getSnapshot().project,
    });
    expect(restored.project?.contentHeader.name).toBeTruthy();
    expect(Object.keys(JSON.parse(storage.getItem()!)).sort()).toEqual(
      ["version", "source", "layout", "cycleMs", "project"].sort(),
    );
    const fresh = createAppStore(new RuntimeClient(new FakeWorker()), restored);
    expect(fresh.getSnapshot()).toMatchObject({
      source: restored.source,
      runtimeState: "STOP",
      snapshot: null,
      loadedSource: null,
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
    expect(readAutosave(storage)?.source).toBe("first edit");
    store.setSource("latest edit");
    autosave.dispose();
    expect(readAutosave(storage)?.source).toBe("latest edit");
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
    const work: SavedWork = { source: "", layout: [], cycleMs: 20, project: null };
    expect(
      readAutosave({ getItem: () => JSON.stringify({ version: 1, ...work }), setItem: vi.fn() }),
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

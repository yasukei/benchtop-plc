import type { Project } from "@benchtop-plc/project";
import type { BrowserStorage } from "./browser-storage.js";
import { readLayout, type PanelLayout } from "./panel/layout.js";

export const autosaveStorageKey = "benchtop-plc.work";
export const cycleOptions = [10, 20, 50, 100] as const;
export type CycleMs = (typeof cycleOptions)[number];

export interface SavedWork {
  source: string;
  layout: PanelLayout;
  cycleMs: CycleMs;
  project: Project | null;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown, required: string[], optional: string[] = []): boolean {
  return (
    record(value) &&
    required.every((key) => typeof value[key] === "string") &&
    optional.every((key) => value[key] === undefined || typeof value[key] === "string")
  );
}

/** Validate metadata without compiling the editor text or converting it to XML. */
function isProject(value: unknown): value is Project {
  return (
    record(value) &&
    strings(
      value.fileHeader,
      ["companyName", "productName", "productVersion", "creationDateTime"],
      ["companyURL", "productRelease", "contentDescription"],
    ) &&
    strings(
      value.contentHeader,
      ["name"],
      ["version", "modificationDateTime", "organization", "author", "language"],
    ) &&
    strings(value, ["program", "configuration", "resource"]) &&
    strings(value.task, ["name", "interval"]) &&
    record(value.task) &&
    typeof value.task.priority === "number" &&
    Number.isInteger(value.task.priority) &&
    value.task.priority >= 0 &&
    value.task.priority <= 65535 &&
    strings(value.instance, ["name", "typeName"]) &&
    (value.panel === null || readLayout(value.panel) !== null)
  );
}

/** Null asks startup to open the bundled example. Invalid source is still valid work. */
export function readAutosave(storage?: BrowserStorage): SavedWork | null {
  try {
    const raw = storage?.getItem(autosaveStorageKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !record(value) ||
      value.version !== 1 ||
      typeof value.source !== "string" ||
      !cycleOptions.includes(value.cycleMs as CycleMs) ||
      !(value.project === null || isProject(value.project))
    )
      return null;
    const layout = readLayout(value.layout);
    if (!layout) return null;
    return {
      source: value.source,
      layout,
      cycleMs: value.cycleMs as CycleMs,
      project: value.project,
    };
  } catch {
    // Corrupt data and blocked storage must never prevent startup.
    return null;
  }
}

interface WorkStore {
  getSnapshot(): SavedWork;
  subscribe(listener: () => void): () => void;
}

/** Subscribe only to editable work; runtime snapshots must not postpone a save. */
export function createAutosave(store: WorkStore, storage?: BrowserStorage) {
  let previous = store.getSnapshot();
  let pending: SavedWork | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    if (!pending) return;
    try {
      storage?.setItem(autosaveStorageKey, JSON.stringify({ version: 1, ...pending }));
    } catch {
      // Editing remains available when storage is blocked or full.
    }
    pending = undefined;
  };
  const unsubscribe = store.subscribe(() => {
    const next = store.getSnapshot();
    if (
      next.source === previous.source &&
      next.layout === previous.layout &&
      next.cycleMs === previous.cycleMs &&
      next.project === previous.project
    )
      return;
    previous = next;
    pending = {
      source: next.source,
      layout: next.layout,
      cycleMs: next.cycleMs,
      project: next.project,
    };
    clearTimeout(timer);
    timer = setTimeout(flush, 500);
  });
  return {
    flush,
    dispose() {
      unsubscribe();
      flush();
    },
  };
}

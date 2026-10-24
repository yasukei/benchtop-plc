import type { Project } from "@benchtop-plc/project";
import {
  createDataTypes,
  createPous,
  derivePou,
  deriveConfiguration,
  type EditorConfiguration,
  type EditorDataType,
  initialPouIndex,
  type EditorPou,
} from "./pous.js";
import type { BrowserStorage } from "./browser-storage.js";
import { readLayout, type PanelLayout } from "./panel/layout.js";

export const autosaveStorageKey = "benchtop-plc.work";
export const cycleOptions = [10, 20, 50, 100] as const;
export type CycleMs = (typeof cycleOptions)[number];

export interface SavedWork {
  configuration: EditorConfiguration | null;
  selectedConfiguration: boolean;
  dataTypes: EditorDataType[];
  selectedDataType: number | null;
  pous: EditorPou[];
  selectedPou: number;
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
    strings(value, ["configuration", "resource"], ["configurationSource"]) &&
    Array.isArray(value.dataTypes) &&
    value.dataTypes.every((source) => typeof source === "string") &&
    Array.isArray(value.pous) &&
    value.pous.every((source) => typeof source === "string") &&
    strings(value.task, ["name", "interval"]) &&
    record(value.task) &&
    typeof value.task.priority === "number" &&
    Number.isInteger(value.task.priority) &&
    value.task.priority >= 0 &&
    value.task.priority <= 65535 &&
    (value.instance === undefined || strings(value.instance, ["name", "typeName"])) &&
    (value.panel === null || readLayout(value.panel) !== null)
  );
}

/** Null asks startup to open the bundled example. Invalid source is still valid work. */
export function readAutosave(storage?: BrowserStorage): SavedWork | null {
  try {
    const raw = storage?.getItem(autosaveStorageKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    // Version 1 autosaves from 0.3.0 stored one program in the project metadata.
    if (
      record(value) &&
      record(value.project) &&
      value.project.pous === undefined &&
      typeof value.project.program === "string"
    ) {
      value.project.pous = [value.project.program];
      delete value.project.program;
    }
    if (!record(value) || ![1, 2, 3, 4].includes(value.version as number)) return null;
    // Older autosaves predate the separate data type source list.
    if (record(value.project) && value.project.dataTypes === undefined)
      value.project.dataTypes = [];
    if (
      !cycleOptions.includes(value.cycleMs as CycleMs) ||
      !(value.project === null || isProject(value.project))
    )
      return null;
    let pous: EditorPou[];
    let selectedPou: number;
    if (value.version === 1) {
      if (typeof value.source !== "string") return null;
      pous = createPous(value.project?.pous.length ? value.project.pous : [value.source]);
      selectedPou = initialPouIndex(pous);
      // The standalone source contains the latest edits, including unparseable drafts.
      pous[selectedPou] = derivePou(value.source, pous[selectedPou]);
    } else {
      if (
        !Array.isArray(value.pous) ||
        !value.pous.every(
          (pou: unknown) =>
            record(pou) &&
            typeof pou.source === "string" &&
            typeof pou.name === "string" &&
            ["PROGRAM", "FUNCTION", "FUNCTION_BLOCK"].includes(pou.kind as string),
        )
      )
        return null;
      if (
        !Number.isInteger(value.selectedPou) ||
        (value.selectedPou as number) < 0 ||
        (value.pous.length
          ? (value.selectedPou as number) >= value.pous.length
          : value.selectedPou !== 0)
      )
        return null;
      pous = value.pous as EditorPou[];
      selectedPou = value.selectedPou as number;
    }
    let dataTypes: EditorDataType[];
    let selectedDataType: number | null;
    if (value.version === 3 || value.version === 4) {
      if (
        !Array.isArray(value.dataTypes) ||
        !value.dataTypes.every(
          (type: unknown) =>
            record(type) &&
            typeof type.source === "string" &&
            typeof type.name === "string" &&
            type.kind === "TYPE",
        )
      )
        return null;
      dataTypes = value.dataTypes as EditorDataType[];
      if (
        value.selectedDataType !== null &&
        (!Number.isInteger(value.selectedDataType) ||
          (value.selectedDataType as number) < 0 ||
          (value.selectedDataType as number) >= dataTypes.length)
      )
        return null;
      selectedDataType = value.selectedDataType as number | null;
    } else {
      dataTypes = createDataTypes(value.project?.dataTypes ?? []);
      selectedDataType = null;
    }
    let configuration: EditorConfiguration | null;
    let selectedConfiguration = false;
    if (value.version === 4) {
      if (
        value.configuration !== null &&
        !(
          record(value.configuration) &&
          typeof value.configuration.source === "string" &&
          typeof value.configuration.name === "string" &&
          value.configuration.kind === "CONFIGURATION"
        )
      )
        return null;
      if (
        typeof value.selectedConfiguration !== "boolean" ||
        (value.selectedConfiguration && (value.configuration === null || selectedDataType !== null))
      )
        return null;
      configuration = value.configuration as EditorConfiguration | null;
      selectedConfiguration = value.selectedConfiguration;
    } else {
      configuration =
        value.project?.configurationSource === undefined
          ? null
          : deriveConfiguration(value.project.configurationSource);
    }
    const layout = readLayout(value.layout);
    if (!layout) return null;
    return {
      configuration,
      selectedConfiguration,
      pous,
      selectedPou,
      dataTypes,
      selectedDataType,
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
      storage?.setItem(autosaveStorageKey, JSON.stringify({ version: 4, ...pending }));
    } catch {
      // Editing remains available when storage is blocked or full.
    }
    pending = undefined;
  };
  const unsubscribe = store.subscribe(() => {
    const next = store.getSnapshot();
    if (
      next.configuration === previous.configuration &&
      next.selectedConfiguration === previous.selectedConfiguration &&
      next.dataTypes === previous.dataTypes &&
      next.selectedDataType === previous.selectedDataType &&
      next.pous === previous.pous &&
      next.selectedPou === previous.selectedPou &&
      next.layout === previous.layout &&
      next.cycleMs === previous.cycleMs &&
      next.project === previous.project
    )
      return;
    previous = next;
    pending = {
      configuration: next.configuration,
      selectedConfiguration: next.selectedConfiguration,
      dataTypes: next.dataTypes,
      selectedDataType: next.selectedDataType,
      pous: next.pous,
      selectedPou: next.selectedPou,
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

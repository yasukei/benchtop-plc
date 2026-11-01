import type { ChangeSet } from "@codemirror/state";
import type { ConfigurationIR, Diagnostic } from "@benchtop-plc/core";
import type { SavedWork } from "./autosave.js";
import type { SourceBreakpoints } from "./breakpoints.js";
import { mapBreakpointLines } from "./breakpoints.js";
import type { InstanceChoices } from "./instances.js";
import {
  addClass,
  addDataType,
  addFunction,
  addFunctionBlock,
  addInterface,
  compilePous,
  configurationTemplate,
  createDataTypes,
  createPous,
  deleteDataType,
  deletePou,
  deriveConfiguration,
  deriveDataType,
  derivePou,
  initialPouIndex,
  pouSources,
  reconcilePouNames,
  type EditorDiagnostic,
  type EditorPou,
} from "./pous.js";
import { selectionFromSaved, selectedPouIndex, type Selection } from "./selection.js";
import type { openPanelProject } from "./panel/project.js";
import type { CycleMs } from "./cycle.js";

export interface EditableWork extends Omit<
  SavedWork,
  "selectedPou" | "selectedDataType" | "selectedConfiguration"
> {
  selection: Selection;
  source: string;
  editorSession: number;
  diagnostics: EditorDiagnostic[];
  /** Latest editor compilation; cleared as soon as any source changes. */
  editorIr?: ConfigurationIR;
  saveDiagnostics: Diagnostic[];
}

/** Effects on mappings to the currently loaded program, applied by the coordinator. */
export interface SourceMappings {
  edit?: { pou: EditorPou; source: string; changes?: ChangeSet };
  removed?: string;
  renames?: ReadonlyMap<string, string>;
}
export interface WorkTransition {
  patch: Partial<EditableWork>;
  mappings?: SourceMappings;
}

export function recompileWork(
  work: Pick<EditableWork, "pous" | "dataTypes" | "project" | "cycleMs" | "configuration">,
) {
  const result = compilePous(
    work.pous,
    pouSources(work.dataTypes),
    work.project,
    work.cycleMs,
    work.configuration,
  );
  return { diagnostics: result.diagnostics, editorIr: result.ir };
}

export function createEditableWork(initial: string | SavedWork): EditableWork {
  const work =
    typeof initial === "string"
      ? {
          pous: createPous([initial]),
          dataTypes: [],
          configuration: null,
          selection: { kind: "pou", index: 0 } as const,
          layout: [],
          project: null,
          cycleMs: 10 as const,
        }
      : (() => {
          const { selectedPou, selectedDataType, selectedConfiguration, ...rest } = initial;
          return {
            ...rest,
            selection: selectionFromSaved({ selectedPou, selectedDataType, selectedConfiguration }),
          };
        })();
  return {
    ...work,
    source: selectedSource(work),
    editorSession: 0,
    saveDiagnostics: [],
    ...recompileWork(work),
  };
}

export function selectedSource(
  work: Pick<EditableWork, "selection" | "pous" | "dataTypes" | "configuration">,
): string {
  switch (work.selection.kind) {
    case "configuration":
      return work.configuration?.source ?? "";
    case "dataType":
      return work.dataTypes[work.selection.index]?.source ?? "";
    case "pou":
      return work.pous[work.selection.index]?.source ?? "";
  }
}

export function selectWork(
  work: EditableWork,
  selection: Selection,
  force = false,
): WorkTransition | undefined {
  const valid =
    selection.kind === "configuration"
      ? work.configuration !== null
      : selection.kind === "dataType"
        ? !!work.dataTypes[selection.index]
        : !!work.pous[selection.index];
  if (
    !valid ||
    (!force &&
      selection.kind === work.selection.kind &&
      (selection.kind === "configuration" ||
        (work.selection.kind !== "configuration" && selection.index === work.selection.index)))
  )
    return;
  return {
    patch: {
      selection,
      source: selectedSource({ ...work, selection }),
      editorSession: work.editorSession + 1,
    },
  };
}

function reconcileDebugNames(
  pous: EditorPou[],
  breakpoints: SourceBreakpoints | undefined,
  instanceChoices: InstanceChoices | undefined,
) {
  const reconciled = reconcilePouNames(pous);
  const renames = new Map(
    pous.flatMap((pou, index) => {
      const oldKey = pou.name.toUpperCase(),
        newKey = reconciled[index]!.name.toUpperCase();
      return oldKey === newKey ? [] : [[oldKey, newKey] as const];
    }),
  );
  const rekey = <T>(entries: Record<string, T> | undefined) =>
    entries &&
    Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [renames.get(key) ?? key, value]),
    );
  return {
    patch: {
      pous: reconciled,
      breakpoints: renames.size ? rekey(breakpoints) : breakpoints,
      instanceChoices: renames.size ? rekey(instanceChoices) : instanceChoices,
    },
    renames,
  };
}

/** Editing also reconciles completed header renames, including collisions and swaps. */
export function editSource(
  work: EditableWork,
  source: string,
  changes?: ChangeSet,
): WorkTransition | undefined {
  if (source === work.source) return;
  const patch: Partial<EditableWork> = {
    source,
    diagnostics: [],
    editorIr: undefined,
    saveDiagnostics: [],
  };
  if (work.selection.kind === "configuration" && work.configuration)
    return { patch: { ...patch, configuration: deriveConfiguration(source, work.configuration) } };
  if (work.selection.kind === "dataType") {
    const selected = work.selection.index;
    return {
      patch: {
        ...patch,
        dataTypes: work.dataTypes.map((type, index) =>
          index === selected ? deriveDataType(source, type) : type,
        ),
      },
    };
  }
  const selected = selectedPouIndex(work.selection);
  const pous = work.pous.length
    ? work.pous.map((pou, index) =>
        index === selected ? { ...derivePou(source, pou), name: pou.name } : pou,
      )
    : createPous([source]);
  const previous = work.pous[selected];
  let breakpoints = work.breakpoints;
  if (previous && pous[selected]) {
    const key = previous.name.toUpperCase();
    breakpoints = { ...breakpoints };
    const lines = mapBreakpointLines(previous.source, source, breakpoints[key] ?? [], changes);
    delete breakpoints[key];
    if (lines.length) breakpoints[key] = lines;
    if (!Object.keys(breakpoints).length) breakpoints = undefined;
  }
  const reconciled = reconcileDebugNames(pous, breakpoints, work.instanceChoices);
  return {
    patch: { ...patch, ...reconciled.patch },
    mappings: {
      ...(previous && pous[selected]
        ? { edit: { pou: previous, source, ...(changes ? { changes } : {}) } }
        : {}),
      renames: reconciled.renames,
    },
  };
}

export type AddSourceKind =
  "dataType" | "function" | "functionBlock" | "class" | "interface" | "configuration";
const pouAdders = {
  function: addFunction,
  functionBlock: addFunctionBlock,
  class: addClass,
  interface: addInterface,
};

/** All source additions share selection, editor-session and compilation handling. */
export function addSource(work: EditableWork, kind: AddSourceKind): WorkTransition | undefined {
  let patch: Partial<EditableWork>;
  const pouIndex = selectedPouIndex(work.selection);
  if (kind === "configuration") {
    if (work.configuration) return;
    patch = {
      configuration: configurationTemplate(work.pous, work.dataTypes, work.project, work.cycleMs),
      selection: { kind: "configuration", pouIndex },
    };
  } else if (kind === "dataType") {
    const dataTypes = addDataType(work.dataTypes, work.pous);
    patch = { dataTypes, selection: { kind: "dataType", index: dataTypes.length - 1, pouIndex } };
  } else {
    const pous = pouAdders[kind](work.pous, work.dataTypes);
    patch = { pous, selection: { kind: "pou", index: kind === "interface" ? 0 : pous.length - 1 } };
  }
  const next = { ...work, ...patch };
  return {
    patch: {
      ...patch,
      source: selectedSource(next),
      editorSession: work.editorSession + 1,
      saveDiagnostics: [],
      ...recompileWork(next),
    },
  };
}

export function deleteSource(
  work: EditableWork,
  kind: "pou" | "dataType" | "configuration",
  index = 0,
): WorkTransition | undefined {
  let patch: Partial<EditableWork>;
  let mappings: SourceMappings | undefined;
  let selection = work.selection;
  if (kind === "configuration") {
    if (!work.configuration) return;
    if (selection.kind === "configuration") selection = { kind: "pou", index: selection.pouIndex };
    patch = { configuration: null, selection };
  } else if (kind === "dataType") {
    const dataTypes = deleteDataType(work.dataTypes, index);
    if (dataTypes === work.dataTypes) return;
    if (selection.kind === "dataType")
      selection = dataTypes.length
        ? {
            ...selection,
            index:
              selection.index > index
                ? selection.index - 1
                : Math.min(selection.index, dataTypes.length - 1),
          }
        : { kind: "pou", index: selection.pouIndex };
    patch = { dataTypes, selection };
  } else {
    const remaining = deletePou(work.pous, index);
    if (remaining === work.pous) return;
    const key = work.pous[index]!.name.toUpperCase();
    const breakpoints = { ...work.breakpoints },
      instanceChoices = { ...work.instanceChoices };
    delete breakpoints[key];
    delete instanceChoices[key];
    const reconciled = reconcileDebugNames(remaining, breakpoints, instanceChoices);
    const previous = selectedPouIndex(selection);
    const pouIndex =
      previous > index ? previous - 1 : Math.max(0, Math.min(previous, remaining.length - 1));
    selection =
      selection.kind === "pou" ? { kind: "pou", index: pouIndex } : { ...selection, pouIndex };
    patch = { ...reconciled.patch, selection };
    mappings = { removed: key, renames: reconciled.renames };
  }
  const next = { ...work, ...patch };
  return {
    patch: {
      ...patch,
      source: selectedSource(next),
      editorSession: work.editorSession + 1,
      saveDiagnostics: [],
      ...recompileWork(next),
    },
    ...(mappings ? { mappings } : {}),
  };
}

export function replaceWork(
  work: EditableWork,
  opened: NonNullable<ReturnType<typeof openPanelProject>>,
  cycleMs: CycleMs,
): WorkTransition {
  const pous = createPous(opened.project.pous);
  const next: EditableWork = {
    ...work,
    retentive: undefined,
    instanceChoices: undefined,
    breakpoints: undefined,
    pous,
    dataTypes: createDataTypes(opened.project.dataTypes),
    selection: { kind: "pou", index: initialPouIndex(pous) },
    configuration:
      opened.project.configurationSource === undefined
        ? null
        : deriveConfiguration(opened.project.configurationSource),
    layout: opened.layout,
    project: opened.project,
    cycleMs,
    editorSession: work.editorSession + 1,
    saveDiagnostics: [],
  };
  return { patch: { ...next, source: selectedSource(next), ...recompileWork(next) } };
}

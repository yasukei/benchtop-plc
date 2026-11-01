import type { ChangeSet } from "@codemirror/state";
import { durationNanoseconds } from "@benchtop-plc/project";
import type { UiToRuntimeMessage } from "@benchtop-plc/core";
import { openPanelProject, serializePanelProject } from "./panel/project.js";
import { pouSources, sameSources } from "./pous.js";
import type { PanelLayout } from "./panel/layout.js";
import { loadExample, type ExampleId } from "./examples.js";
import type { RuntimeClient } from "./runtime-client.js";
import type { SavedWork } from "./autosave.js";
import { cycleOptions, type CycleMs } from "./cycle.js";
import {
  addSource,
  createEditableWork,
  deleteSource,
  editSource,
  recompileWork,
  replaceWork,
  selectWork,
  type AddSourceKind,
  type WorkTransition,
} from "./editable-work.js";
import { savedSelection, selectedPouIndex } from "./selection.js";
import { createWorkerCoordinator } from "./worker-coordinator.js";
import type { AppState, StoreState } from "./store-state.js";

export { cycleOptions } from "./cycle.js";
export type { CycleMs } from "./cycle.js";
export type { AppState } from "./store-state.js";

/** A cached snapshot and subscription API suitable for React's useSyncExternalStore. */
export function createAppStore(client: RuntimeClient, initial: string | SavedWork = "") {
  let state: StoreState = {
    ...createEditableWork(initial),
    halted: null,
    selectedFrame: 0,
    storageWarning: false,
    retentiveSkipped: [],
    openDiagnostics: [],
    openProjectError: null,
    emergencyActive: false,
    emergencyReleased: false,
    loadedSources: null,
    loadedDataTypes: null,
    loadedConfigurationSource: null,
    runtimeState: "STOP",
    snapshot: null,
    diagnostic: null,
    rejection: null,
    connection: "connected",
  };
  const publicSnapshot = (): AppState => {
    const { selection, ...rest } = state;
    return { ...rest, ...savedSelection(selection) };
  };
  let snapshot = publicSnapshot();
  let compileTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const update = (patch: Partial<StoreState>) => {
    state = { ...state, ...patch };
    snapshot = publicSnapshot();
    for (const listener of listeners) listener();
    coordinator.synchronize();
  };
  const coordinator = createWorkerCoordinator(client, () => state, update);
  const applyWork = (transition: WorkTransition | undefined) => {
    if (!transition) return false;
    coordinator.applySourceMappings(transition.mappings);
    update(transition.patch);
    return true;
  };
  const compileEditor = () => {
    clearTimeout(compileTimer);
    const result = recompileWork(state);
    update(result);
    return result;
  };
  const loadEditor = () => {
    if (state.connection !== "connected") return false;
    const result = compileEditor();
    return result.editorIr ? coordinator.load(result.editorIr) : false;
  };
  const add = (kind: AddSourceKind) => {
    const transition = addSource(state, kind);
    if (!transition) return;
    clearTimeout(compileTimer);
    applyWork(transition);
  };
  const remove = (kind: "pou" | "dataType" | "configuration", index?: number) => {
    const transition = deleteSource(state, kind, index);
    if (!transition) return;
    clearTimeout(compileTimer);
    applyWork(transition);
  };
  const openProject = (xml: string) => {
    if (state.openProjectError !== null) update({ openProjectError: null });
    if (state.saveDiagnostics.length) update({ saveDiagnostics: [] });
    if (
      coordinator.loading ||
      state.runtimeState !== "STOP" ||
      state.emergencyActive ||
      state.connection !== "connected"
    )
      return false;
    const opened = openPanelProject(xml);
    if (!opened) return false;
    let ms: CycleMs | undefined = state.cycleMs;
    if (opened.project.configurationSource === undefined) {
      const nanoseconds = durationNanoseconds(opened.project.task.interval);
      ms = cycleOptions.find((cycle) => BigInt(cycle) * 1000000n === nanoseconds);
      if (ms === undefined) {
        update({ openProjectError: "unsupported-cycle" });
        return false;
      }
    }
    clearTimeout(compileTimer);
    coordinator.replaceProject();
    update({
      ...replaceWork(state, opened, ms).patch,
      retentiveSkipped: [],
      halted: null,
      openDiagnostics: opened.diagnostics,
      // Identical editor text can belong to a different project-wide compilation.
      loadedSources: null,
      loadedDataTypes: null,
      loadedConfigurationSource: null,
      loadedIr: undefined,
      snapshot: null,
      diagnostic: null,
      rejection: null,
    });
    // The loaded configuration IR supplies its cycle, including implicit projects.
    loadEditor();
    return true;
  };
  return {
    getSnapshot: () => snapshot,
    dismissOpenDiagnostics() {
      update({ openDiagnostics: [] });
    },
    storageFailed() {
      if (!state.storageWarning) update({ storageWarning: true });
    },
    setLayout(layout: PanelLayout) {
      update({ layout });
    },
    saveProject() {
      const result = serializePanelProject(
        pouSources(state.pous),
        state.layout,
        state.cycleMs,
        state.project,
        pouSources(state.dataTypes),
        state.configuration?.source ?? null,
      );
      update({ saveDiagnostics: result.diagnostics });
      return result.value;
    },
    openProject,
    async openExample(id: ExampleId) {
      const before = state;
      try {
        const xml = await loadExample(id);
        // Fetching must not discard work edited after the user confirmed replacement.
        if (
          !sameSources(pouSources(state.pous), pouSources(before.pous)) ||
          !sameSources(pouSources(state.dataTypes), pouSources(before.dataTypes)) ||
          state.configuration?.source !== before.configuration?.source ||
          state.layout !== before.layout ||
          state.cycleMs !== before.cycleMs ||
          state.project !== before.project
        )
          return false;
        return openProject(xml);
      } catch {
        update({ openProjectError: "example-load" });
        return false;
      }
    },
    setEmergency(active: boolean) {
      if (state.connection !== "connected") return;
      update({ emergencyActive: active, emergencyReleased: !active });
      client.send({ type: "estop", active });
    },
    setSource(source: string, changes?: ChangeSet) {
      if (source === state.source) return;
      clearTimeout(compileTimer);
      applyWork(editSource(state, source, changes));
      compileTimer = setTimeout(compileEditor, 250);
    },
    runtimeSource: coordinator.runtimeSource,
    breakpointMarkers: coordinator.breakpointMarkers,
    toggleBreakpoint(line: number) {
      if (state.selection.kind !== "pou") return;
      const pou = state.pous[selectedPouIndex(state.selection)];
      if (!pou || pou.kind === "INTERFACE" || line < 1 || line > pou.source.split("\n").length)
        return;
      const key = pou.name.toUpperCase();
      const lines = state.breakpoints?.[key] ?? [];
      update({
        breakpoints: {
          ...state.breakpoints,
          [key]: lines.includes(line)
            ? lines.filter((item) => item !== line)
            : [...lines, line].sort((a, b) => a - b),
        },
      });
    },
    selectFrame: coordinator.selectFrame,
    selectInstance: coordinator.selectInstance,
    selectPou(index: number) {
      applyWork(selectWork(state, { kind: "pou", index }));
    },
    selectDataType(index: number) {
      applyWork(
        selectWork(state, { kind: "dataType", index, pouIndex: selectedPouIndex(state.selection) }),
      );
    },
    selectConfiguration() {
      applyWork(
        selectWork(state, { kind: "configuration", pouIndex: selectedPouIndex(state.selection) }),
      );
    },
    addConfiguration: () => add("configuration"),
    deleteConfiguration: () => remove("configuration"),
    addDataType: () => add("dataType"),
    deleteDataType: (index: number) => remove("dataType", index),
    addFunction: () => add("function"),
    addFunctionBlock: () => add("functionBlock"),
    addClass: () => add("class"),
    addInterface: () => add("interface"),
    deletePou: (index: number) => remove("pou", index),
    loadEditor,
    run() {
      if (state.connection !== "connected" || coordinator.loading || state.emergencyActive) return;
      if (
        state.runtimeState !== "STOP" &&
        state.runtimeState !== "RUN" &&
        state.runtimeState !== "HALT"
      )
        return;
      if (
        state.runtimeState === "HALT" &&
        sameSources(pouSources(state.pous), state.loadedSources) &&
        sameSources(pouSources(state.dataTypes), state.loadedDataTypes) &&
        (state.configuration?.source ?? null) === state.loadedConfigurationSource
      )
        return;
      if (
        (!sameSources(pouSources(state.pous), state.loadedSources) ||
          !sameSources(pouSources(state.dataTypes), state.loadedDataTypes) ||
          (state.configuration?.source ?? null) !== state.loadedConfigurationSource) &&
        !loadEditor()
      )
        return;
      if (state.rejection) update({ rejection: null });
      update({ emergencyReleased: false });
      client.send({ type: "run" });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    send(message: UiToRuntimeMessage) {
      coordinator.send(message);
    },
    dispose() {
      clearTimeout(compileTimer);
      coordinator.dispose();
      listeners.clear();
    },
  };
}

export type AppStore = ReturnType<typeof createAppStore>;

import { openPanelProject, serializePanelProject } from "./panel/project.js";
import {
  addDataType,
  configurationTemplate,
  deriveConfiguration,
  createDataTypes,
  deriveDataType,
  deleteDataType,
  addFunction,
  addFunctionBlock,
  compilePous,
  createPous,
  deletePou,
  derivePou,
  initialPouIndex,
  pouSources,
  sameSources,
  type EditorDiagnostic,
} from "./pous.js";
import type { PanelLayout } from "./panel/layout.js";
import blinkProjectXml from "../../../examples/blink/project.xml?raw";
import type {
  CommandRejectionMessage,
  ConfigurationIR,
  Diagnostic,
  RuntimeSnapshot,
  RuntimeState,
  UiToRuntimeMessage,
} from "@benchtop-plc/core";
import type { ClientEvent, RuntimeClient } from "./runtime-client.js";
import { cycleOptions, type CycleMs, type SavedWork } from "./autosave.js";

export { cycleOptions } from "./autosave.js";
export type { CycleMs } from "./autosave.js";

export interface AppState extends SavedWork {
  storageWarning: boolean;
  retentiveSkipped: string[];
  source: string;
  editorSession: number;
  saveDiagnostics: Diagnostic[];
  layout: PanelLayout;
  emergencyActive: boolean;
  emergencyReleased: boolean;
  loadedSources: string[] | null;
  loadedDataTypes: string[] | null;
  loadedConfigurationSource: string | null;
  loadedIr?: ConfigurationIR;
  diagnostics: EditorDiagnostic[];
  runtimeState: RuntimeState;
  snapshot: RuntimeSnapshot | null;
  diagnostic: Diagnostic | null;
  rejection: CommandRejectionMessage | null;
  cycleMs: CycleMs;
  connection: "connected" | "failed" | "closed";
}

/** A cached snapshot and subscription API suitable for React's useSyncExternalStore. */
export function createAppStore(client: RuntimeClient, initial: string | SavedWork = "") {
  const pous = typeof initial === "string" ? createPous([initial]) : initial.pous;
  const selectedPou = typeof initial === "string" ? 0 : initial.selectedPou;
  const dataTypes = typeof initial === "string" ? [] : initial.dataTypes;
  const selectedDataType = typeof initial === "string" ? null : initial.selectedDataType;
  const configuration = typeof initial === "string" ? null : initial.configuration;
  const selectedConfiguration = typeof initial === "string" ? false : initial.selectedConfiguration;
  const source = selectedConfiguration
    ? configuration!.source
    : ((selectedDataType === null ? pous[selectedPou] : dataTypes[selectedDataType])?.source ?? "");
  let pendingRestore = typeof initial === "string" ? undefined : initial.retentive;
  let state: AppState = {
    storageWarning: false,
    retentiveSkipped: [],
    ...(pendingRestore === undefined ? {} : { retentive: pendingRestore }),
    source,
    configuration,
    selectedConfiguration,
    dataTypes,
    selectedDataType,
    editorSession: 0,
    saveDiagnostics: [],
    pous,
    selectedPou,
    layout: typeof initial === "string" ? [] : initial.layout,
    project: typeof initial === "string" ? null : initial.project,
    emergencyActive: false,
    emergencyReleased: false,
    loadedSources: null,
    loadedDataTypes: null,
    loadedConfigurationSource: null,
    diagnostics: compilePous(
      pous,
      pouSources(dataTypes),
      typeof initial === "string" ? null : initial.project,
      typeof initial === "string" ? 10 : initial.cycleMs,
      configuration,
    ).diagnostics,
    runtimeState: "STOP",
    snapshot: null,
    diagnostic: null,
    rejection: null,
    cycleMs: typeof initial === "string" ? 10 : initial.cycleMs,
    connection: "connected",
  };
  let compileTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingLoads: {
    loadedSources: string[];
    loadedDataTypes: string[];
    loadedConfigurationSource: string | null;
    loadedIr: ConfigurationIR;
  }[] = [];
  const listeners = new Set<() => void>();
  const update = (patch: Partial<AppState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const unsubscribe = client.subscribe((event: ClientEvent) => {
    switch (event.type) {
      case "retentive":
        update({ retentive: event.records });
        break;
      case "retentiveRestored":
        update({ retentiveSkipped: event.skipped });
        break;
      case "state":
        update({ runtimeState: event.state });
        break;
      case "snapshot":
        // A load publishes an empty, zero-scan snapshot before execution can resume.
        // Ignore scans already queued by the previously loaded program.
        if (pendingLoads.length && event.snapshot.scanCount !== 0) break;
        update({
          ...(pendingLoads.length ? pendingLoads.shift()! : {}),
          snapshot: event.snapshot,
          ...(event.snapshot.scanCount === 0 ? { diagnostic: null } : {}),
        });
        break;
      case "fault":
        update({ diagnostic: event.diagnostic });
        break;
      case "rejected":
        update({ rejection: event });
        break;
      case "connectionError":
        update({ connection: "failed" });
        break;
      case "closed":
        update({ connection: "closed" });
        break;
    }
  });
  const compileEditor = () => {
    clearTimeout(compileTimer);
    const result = compilePous(
      state.pous,
      pouSources(state.dataTypes),
      state.project,
      state.cycleMs,
      state.configuration,
    );
    update({ diagnostics: result.diagnostics });
    return result;
  };
  const loadEditor = () => {
    if (state.connection !== "connected") return false;
    const result = compileEditor();
    if (!result.ir) return false;
    pendingLoads.push({
      loadedSources: pouSources(state.pous),
      loadedDataTypes: pouSources(state.dataTypes),
      loadedConfigurationSource: state.configuration?.source ?? null,
      loadedIr: result.ir,
    });
    update({ snapshot: null, diagnostic: null, rejection: null });
    const retentive = pendingRestore;
    pendingRestore = undefined;
    client.send({ type: "load", ir: result.ir, ...(retentive === undefined ? {} : { retentive }) });
    return true;
  };
  const openProject = (xml: string) => {
    if (state.saveDiagnostics.length) update({ saveDiagnostics: [] });
    if (
      pendingLoads.length > 0 ||
      state.runtimeState !== "STOP" ||
      state.emergencyActive ||
      state.connection !== "connected"
    )
      return false;
    const opened = openPanelProject(xml);
    if (!opened) return false;
    const ms =
      opened.project.configurationSource === undefined
        ? Number(/^PT([0-9.]+)S$/.exec(opened.project.task.interval)?.[1]) * 1000
        : state.cycleMs;
    if (!cycleOptions.includes(ms as CycleMs)) return false;
    clearTimeout(compileTimer);
    const pous = createPous(opened.project.pous);
    const selectedPou = initialPouIndex(pous);
    const dataTypes = createDataTypes(opened.project.dataTypes);
    update({
      pous,
      selectedPou,
      dataTypes,
      selectedDataType: null,
      selectedConfiguration: false,
      configuration:
        opened.project.configurationSource === undefined
          ? null
          : deriveConfiguration(opened.project.configurationSource),
      editorSession: state.editorSession + 1,
      saveDiagnostics: [],
      source: pous[selectedPou]?.source ?? "",
      layout: opened.layout,
      project: opened.project,
      diagnostics: compilePous(pous, opened.project.dataTypes, opened.project, ms).diagnostics,
      cycleMs: ms as CycleMs,
      // Identical editor text can belong to a different project-wide compilation.
      loadedSources: null,
      loadedDataTypes: null,
      loadedConfigurationSource: null,
      loadedIr: undefined,
      snapshot: null,
      diagnostic: null,
      rejection: null,
    });
    pendingRestore = undefined;
    update({ retentiveSkipped: [] });
    // The loaded configuration IR supplies its cycle, including implicit projects.
    loadEditor();
    return true;
  };
  return {
    getSnapshot: () => state,
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
    restoreExample: () => openProject(blinkProjectXml),
    setEmergency(active: boolean) {
      if (state.connection !== "connected") return;
      update({ emergencyActive: active, emergencyReleased: !active });
      client.send({ type: "estop", active });
    },
    setSource(source: string) {
      if (source === state.source) return;
      clearTimeout(compileTimer);
      if (state.selectedConfiguration && state.configuration) {
        update({
          source,
          configuration: deriveConfiguration(source, state.configuration),
          diagnostics: [],
          saveDiagnostics: [],
        });
        compileTimer = setTimeout(compileEditor, 250);
        return;
      }
      if (state.selectedDataType !== null) {
        const dataTypes = state.dataTypes.map((type, index) =>
          index === state.selectedDataType ? deriveDataType(source, type) : type,
        );
        update({ source, dataTypes, diagnostics: [], saveDiagnostics: [] });
        compileTimer = setTimeout(compileEditor, 250);
        return;
      }
      const pous = state.pous.length
        ? state.pous.map((pou, index) =>
            index === state.selectedPou ? derivePou(source, pou) : pou,
          )
        : createPous([source]);
      update({ source, pous, diagnostics: [], saveDiagnostics: [] });
      compileTimer = setTimeout(compileEditor, 250);
    },
    selectPou(index: number) {
      if (
        !state.pous[index] ||
        (index === state.selectedPou &&
          state.selectedDataType === null &&
          !state.selectedConfiguration)
      )
        return;
      update({
        selectedPou: index,
        selectedConfiguration: false,
        selectedDataType: null,
        source: state.pous[index]!.source,
        editorSession: state.editorSession + 1,
      });
    },
    selectDataType(index: number) {
      if (!state.dataTypes[index] || index === state.selectedDataType) return;
      update({
        selectedDataType: index,
        selectedConfiguration: false,
        source: state.dataTypes[index]!.source,
        editorSession: state.editorSession + 1,
      });
    },
    selectConfiguration() {
      if (!state.configuration || state.selectedConfiguration) return;
      update({
        selectedConfiguration: true,
        selectedDataType: null,
        source: state.configuration.source,
        editorSession: state.editorSession + 1,
      });
    },
    addConfiguration() {
      if (state.configuration) return;
      clearTimeout(compileTimer);
      const configuration = configurationTemplate(
        state.pous,
        state.dataTypes,
        state.project,
        state.cycleMs,
      );
      update({
        configuration,
        selectedConfiguration: true,
        selectedDataType: null,
        source: configuration.source,
        editorSession: state.editorSession + 1,
        saveDiagnostics: [],
      });
      compileEditor();
    },
    deleteConfiguration() {
      if (!state.configuration) return;
      clearTimeout(compileTimer);
      update({
        configuration: null,
        selectedConfiguration: false,
        source: state.selectedConfiguration
          ? (state.pous[state.selectedPou]?.source ?? "")
          : state.source,
        editorSession: state.editorSession + 1,
        saveDiagnostics: [],
      });
      compileEditor();
    },
    addDataType() {
      clearTimeout(compileTimer);
      const dataTypes = addDataType(state.dataTypes, state.pous);
      update({
        dataTypes,
        selectedConfiguration: false,
        selectedDataType: dataTypes.length - 1,
        source: dataTypes.at(-1)!.source,
        editorSession: state.editorSession + 1,
        saveDiagnostics: [],
        diagnostics: compilePous(
          state.pous,
          pouSources(dataTypes),
          state.project,
          state.cycleMs,
          state.configuration,
        ).diagnostics,
      });
    },
    deleteDataType(index: number) {
      const dataTypes = deleteDataType(state.dataTypes, index);
      if (dataTypes === state.dataTypes) return;
      clearTimeout(compileTimer);
      const selectedDataType =
        state.selectedDataType === null
          ? null
          : dataTypes.length === 0
            ? null
            : state.selectedDataType > index
              ? state.selectedDataType - 1
              : Math.min(state.selectedDataType, dataTypes.length - 1);
      update({
        dataTypes,
        selectedDataType,
        source:
          (state.selectedConfiguration
            ? state.configuration
            : selectedDataType === null
              ? state.pous[state.selectedPou]
              : dataTypes[selectedDataType]
          )?.source ?? "",
        editorSession: state.editorSession + 1,
        saveDiagnostics: [],
        diagnostics: compilePous(
          state.pous,
          pouSources(dataTypes),
          state.project,
          state.cycleMs,
          state.configuration,
        ).diagnostics,
      });
    },
    addFunction() {
      clearTimeout(compileTimer);
      const pous = addFunction(state.pous, state.dataTypes);
      update({
        pous,
        editorSession: state.editorSession + 1,
        saveDiagnostics: [],
        selectedPou: pous.length - 1,
        selectedConfiguration: false,
        selectedDataType: null,
        source: pous.at(-1)!.source,
        diagnostics: compilePous(
          pous,
          pouSources(state.dataTypes),
          state.project,
          state.cycleMs,
          state.configuration,
        ).diagnostics,
      });
    },
    addFunctionBlock() {
      clearTimeout(compileTimer);
      const pous = addFunctionBlock(state.pous, state.dataTypes);
      update({
        pous,
        editorSession: state.editorSession + 1,
        saveDiagnostics: [],
        selectedPou: pous.length - 1,
        selectedConfiguration: false,
        selectedDataType: null,
        source: pous.at(-1)!.source,
        diagnostics: compilePous(
          pous,
          pouSources(state.dataTypes),
          state.project,
          state.cycleMs,
          state.configuration,
        ).diagnostics,
      });
    },
    deletePou(index: number) {
      const pous = deletePou(state.pous, index);
      if (pous === state.pous) return;
      clearTimeout(compileTimer);
      const selectedPou =
        state.selectedPou > index
          ? state.selectedPou - 1
          : Math.max(0, Math.min(state.selectedPou, pous.length - 1));
      update({
        pous,
        editorSession: state.editorSession + 1,
        saveDiagnostics: [],
        selectedPou,
        source:
          (state.selectedConfiguration
            ? state.configuration
            : state.selectedDataType === null
              ? pous[selectedPou]
              : state.dataTypes[state.selectedDataType]
          )?.source ?? "",
        diagnostics: compilePous(
          pous,
          pouSources(state.dataTypes),
          state.project,
          state.cycleMs,
          state.configuration,
        ).diagnostics,
      });
    },
    loadEditor,
    run() {
      if (state.connection !== "connected" || pendingLoads.length || state.emergencyActive) return;
      if (state.runtimeState !== "STOP" && state.runtimeState !== "RUN") return;
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
      if (state.connection !== "connected") return;
      if (state.rejection) update({ rejection: null });
      if (message.type === "setCycle") {
        if (state.configuration) return;
        if (!cycleOptions.includes(message.ms as CycleMs))
          throw new RangeError("Unsupported cycle");
        update({ cycleMs: message.ms as CycleMs });
        if (state.loadedIr?.explicit) return;
      }
      client.send(message);
    },
    dispose() {
      clearTimeout(compileTimer);
      unsubscribe();
      listeners.clear();
    },
  };
}

export type AppStore = ReturnType<typeof createAppStore>;

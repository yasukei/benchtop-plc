import type { ChangeSet } from "@codemirror/state";
import { durationNanoseconds } from "@benchtop-plc/project";
import { haltPoints, mapBreakpointLines, mapSourceLines } from "./breakpoints.js";
import { openPanelProject, serializePanelProject } from "./panel/project.js";
import {
  addDataType,
  diagnosticPouIndex,
  configurationTemplate,
  deriveConfiguration,
  createDataTypes,
  deriveDataType,
  deleteDataType,
  addFunction,
  addFunctionBlock,
  addClass,
  addInterface,
  compilePous,
  createPous,
  deletePou,
  derivePou,
  reconcilePouNames,
  initialPouIndex,
  pouSources,
  sameSources,
  type EditorDiagnostic,
  type EditorPou,
} from "./pous.js";
import type { PanelLayout } from "./panel/layout.js";
import blinkProjectXml from "../../../examples/blink/project.xml?raw";
import type {
  CommandRejectionMessage,
  ConfigurationIR,
  Diagnostic,
  HaltedMessage,
  RuntimeSnapshot,
  RuntimeState,
  RetentiveRecord,
  UiToRuntimeMessage,
} from "@benchtop-plc/core";
import type { ClientEvent, RuntimeClient } from "./runtime-client.js";
import { cycleOptions, type CycleMs, type SavedWork } from "./autosave.js";

import { instancesForSource, watchedBodies } from "./instances.js";

export { cycleOptions } from "./autosave.js";
export type { CycleMs } from "./autosave.js";

export interface AppState extends SavedWork {
  storageWarning: boolean;
  retentiveSkipped: string[];
  source: string;
  editorSession: number;
  saveDiagnostics: Diagnostic[];
  openDiagnostics: Diagnostic[];
  openProjectError: "unsupported-cycle" | null;
  layout: PanelLayout;
  emergencyActive: boolean;
  emergencyReleased: boolean;
  loadedSources: string[] | null;
  loadedDataTypes: string[] | null;
  loadedConfigurationSource: string | null;
  loadedIr?: ConfigurationIR;
  /** Latest editor compilation; cleared as soon as any source changes. */
  editorIr?: ConfigurationIR;
  diagnostics: EditorDiagnostic[];
  runtimeState: RuntimeState;
  halted: HaltedMessage | null;
  selectedFrame: number;
  snapshot: RuntimeSnapshot | null;
  diagnostic: Diagnostic | null;
  rejection: CommandRejectionMessage | null;
  cycleMs: CycleMs;
  connection: "connected" | "failed" | "closed";
}

function compileEditorState(...args: Parameters<typeof compilePous>) {
  const result = compilePous(...args);
  return { diagnostics: result.diagnostics, editorIr: result.ir };
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
  let awaitingProjectLoad = false;
  let state: AppState = {
    ...(typeof initial === "string" || initial.breakpoints === undefined
      ? {}
      : { breakpoints: initial.breakpoints }),
    halted: null,
    selectedFrame: 0,
    ...(typeof initial === "string" || initial.instanceChoices === undefined
      ? {}
      : { instanceChoices: initial.instanceChoices }),
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
    openDiagnostics: [],
    openProjectError: null,
    pous,
    selectedPou,
    layout: typeof initial === "string" ? [] : initial.layout,
    project: typeof initial === "string" ? null : initial.project,
    emergencyActive: false,
    emergencyReleased: false,
    loadedSources: null,
    loadedDataTypes: null,
    loadedConfigurationSource: null,
    ...compileEditorState(
      pous,
      pouSources(dataTypes),
      typeof initial === "string" ? null : initial.project,
      typeof initial === "string" ? 10 : initial.cycleMs,
      configuration,
    ),
    runtimeState: "STOP",
    snapshot: null,
    diagnostic: null,
    rejection: null,
    cycleMs: typeof initial === "string" ? 10 : initial.cycleMs,
    connection: "connected",
  };
  let compileTimer: ReturnType<typeof setTimeout> | undefined;
  let nextLoadId = 1;
  let loadFailed = false;
  const pendingLoads: {
    loadId: number;
    retentive?: RetentiveRecord[];
    loaded: {
      loadedSources: string[];
      loadedDataTypes: string[];
      loadedConfigurationSource: string | null;
      loadedIr: ConfigurationIR;
    };
  }[] = [];
  const listeners = new Set<() => void>();
  let lastBodyWatches = "";
  let lastBreakpoints = "";
  const lineOrigins = new Map<string, { name: string; lines: (number | null)[] }>();
  const reconcileDebugNames = (
    pous: EditorPou[],
    breakpoints: AppState["breakpoints"],
    instanceChoices = state.instanceChoices,
  ) => {
    const reconciled = reconcilePouNames(pous);
    const renames = new Map(
      pous.flatMap((pou, index) => {
        const oldKey = pou.name.toUpperCase(),
          newKey = reconciled[index]!.name.toUpperCase();
        return oldKey === newKey ? [] : [[oldKey, newKey] as const];
      }),
    );
    if (!renames.size) return { pous: reconciled, breakpoints, instanceChoices };
    // Read all old entries before writing any destinations, so swaps cannot overwrite them.
    const rekey = <T>(entries: Iterable<readonly [string, T]>) =>
      Array.from(entries, ([key, value]) => [renames.get(key) ?? key, value] as const);
    const origins = rekey(lineOrigins);
    lineOrigins.clear();
    for (const [key, mapping] of origins) lineOrigins.set(key, mapping);
    return {
      pous: reconciled,
      breakpoints: breakpoints && Object.fromEntries(rekey(Object.entries(breakpoints))),
      instanceChoices:
        instanceChoices && Object.fromEntries(rekey(Object.entries(instanceChoices))),
    };
  };
  const runtimeName = (pou: { name: string }) =>
    lineOrigins.get(pou.name.toUpperCase())?.name ?? pou.name;
  const runtimeChoices = () => {
    const choices = { ...state.instanceChoices };
    for (const pou of state.pous) {
      const path = state.instanceChoices?.[pou.name.toUpperCase()];
      if (path) choices[runtimeName(pou).toUpperCase()] = path;
    }
    return choices;
  };
  const sendBreakpoints = (ir: ConfigurationIR) => {
    if (state.connection !== "connected") return;
    const breakpoints = state.pous.flatMap((pou) => {
      const mapping = lineOrigins.get(pou.name.toUpperCase());
      if (!mapping) return [];
      const loadedLines = new Set(
        (state.breakpoints?.[pou.name.toUpperCase()] ?? [])
          .map((line) => mapping.lines[line - 1])
          .filter((line) => line != null),
      );
      return haltPoints(ir, mapping.name).filter((point) => loadedLines.has(point.line));
    });
    const key = JSON.stringify(breakpoints);
    if (key === "[]" && lastBreakpoints === "") return;
    if (key !== lastBreakpoints) {
      lastBreakpoints = key;
      client.send({ type: "setBreakpoints", breakpoints });
    }
  };
  const sendBodyWatches = (ir: ConfigurationIR) => {
    if (state.connection !== "connected") return;
    const openPou =
      !state.selectedConfiguration && state.selectedDataType === null
        ? state.pous[state.selectedPou]
          ? runtimeName(state.pous[state.selectedPou]!)
          : undefined
        : undefined;
    const bodies = watchedBodies(ir, runtimeChoices(), openPou);
    const key = JSON.stringify(bodies);
    if (key !== lastBodyWatches) {
      lastBodyWatches = key;
      client.send({ type: "watchBodies", bodies });
    }
  };
  const update = (patch: Partial<AppState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
    if (state.loadedIr && !pendingLoads.length) {
      sendBodyWatches(state.loadedIr);
      sendBreakpoints(state.loadedIr);
    }
  };
  const frameSelection = (event: HaltedMessage, selectedFrame: number): Partial<AppState> => {
    const frame = event.frames[selectedFrame];
    const index = frame
      ? diagnosticPouIndex(
          state.pous.map((pou) => ({ ...pou, name: runtimeName(pou) })),
          { code: "runtime.halted", severity: "error", args: {}, pou: frame.pou },
        )
      : undefined;
    const pou = index === undefined ? undefined : state.pous[index];
    return {
      selectedFrame,
      ...(pou
        ? {
            selectedPou: index!,
            selectedConfiguration: false,
            selectedDataType: null,
            source: pou.source,
            editorSession: state.editorSession + 1,
            ...(frame?.instance
              ? {
                  instanceChoices: {
                    ...state.instanceChoices,
                    [pou.name.toUpperCase()]: frame.instance,
                  },
                }
              : {}),
          }
        : {}),
    };
  };
  const unsubscribe = client.subscribe((event: ClientEvent) => {
    switch (event.type) {
      case "retentive":
        // An uncompilable import leaves the previous project's runtime in the Worker.
        if (awaitingProjectLoad) break;
        update({ retentive: event.records });
        break;
      case "retentiveRestored":
        update({ retentiveSkipped: event.skipped });
        break;
      case "halted": {
        update({ halted: event, ...frameSelection(event, 0) });
        break;
      }
      case "state":
        update({ runtimeState: event.state, ...(event.state !== "HALT" ? { halted: null } : {}) });
        break;
      case "snapshot": {
        if (event.loadId !== undefined) {
          const index = pendingLoads.findIndex((load) => load.loadId === event.loadId);
          if (index === -1) break;
          const { loaded } = pendingLoads.splice(index, 1)[0]!;
          // Keep the monitor empty while a newer attempt is still in flight.
          if (pendingLoads.length) break;
          loadFailed = false;
          update({ ...loaded, snapshot: event.snapshot, diagnostic: null });
        } else {
          // Ordinary commands can also reply at scan zero; they never acknowledge a load.
          if (pendingLoads.length || loadFailed) break;
          update({
            snapshot: event.snapshot,
            ...(event.snapshot.scanCount === 0 ? { diagnostic: null } : {}),
          });
        }
        break;
      }
      case "fault":
        if (event.loadId !== undefined) {
          const index = pendingLoads.findIndex((load) => load.loadId === event.loadId);
          if (index === -1) break;
          const failed = pendingLoads.splice(index, 1)[0]!;
          if (pendingLoads.length) break;
          pendingRestore = failed.retentive;
          loadFailed = true;
          update({
            loadedSources: null,
            loadedDataTypes: null,
            loadedConfigurationSource: null,
            loadedIr: undefined,
            snapshot: null,
            diagnostic: event.diagnostic,
          });
        } else update({ diagnostic: event.diagnostic });
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
    update({ diagnostics: result.diagnostics, editorIr: result.ir });
    return result;
  };
  const loadEditor = () => {
    if (state.connection !== "connected") return false;
    const result = compileEditor();
    if (!result.ir) return false;
    lastBodyWatches = "";
    if (lastBreakpoints && lastBreakpoints !== "[]") lastBreakpoints = "reload";
    lineOrigins.clear();
    for (const pou of state.pous)
      lineOrigins.set(pou.name.toUpperCase(), {
        name: pou.name,
        lines: pou.source.split("\n").map((_, index) => index + 1),
      });
    const loadId = nextLoadId++;
    const retentive = pendingRestore;
    pendingRestore = undefined;
    pendingLoads.push({
      loadId,
      ...(retentive === undefined ? {} : { retentive }),
      loaded: {
        loadedSources: pouSources(state.pous),
        loadedDataTypes: pouSources(state.dataTypes),
        loadedConfigurationSource: state.configuration?.source ?? null,
        loadedIr: result.ir,
      },
    });
    update({ snapshot: null, diagnostic: null, rejection: null, retentiveSkipped: [] });
    awaitingProjectLoad = false;
    client.send({
      type: "load",
      loadId,
      ir: result.ir,
      ...(retentive === undefined ? {} : { retentive }),
    });
    // Queue watches before RUN can activate an event task, without waiting for the load reply.
    sendBodyWatches(result.ir);
    sendBreakpoints(result.ir);
    return true;
  };
  const openProject = (xml: string) => {
    if (state.openProjectError !== null) update({ openProjectError: null });
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
    const pous = createPous(opened.project.pous);
    const selectedPou = initialPouIndex(pous);
    const dataTypes = createDataTypes(opened.project.dataTypes);
    pendingRestore = undefined;
    awaitingProjectLoad = true;
    update({
      retentive: undefined,
      retentiveSkipped: [],
      instanceChoices: undefined,
      breakpoints: undefined,
      halted: null,
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
      openDiagnostics: opened.diagnostics,
      source: pous[selectedPou]?.source ?? "",
      layout: opened.layout,
      project: opened.project,
      ...compileEditorState(pous, opened.project.dataTypes, opened.project, ms),
      cycleMs: ms,
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
    getSnapshot: () => state,
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
    restoreExample: () => openProject(blinkProjectXml),
    setEmergency(active: boolean) {
      if (state.connection !== "connected") return;
      update({ emergencyActive: active, emergencyReleased: !active });
      client.send({ type: "estop", active });
    },
    setSource(source: string, changes?: ChangeSet) {
      if (source === state.source) return;
      clearTimeout(compileTimer);
      if (state.selectedConfiguration && state.configuration) {
        update({
          source,
          configuration: deriveConfiguration(source, state.configuration),
          diagnostics: [],
          editorIr: undefined,
          saveDiagnostics: [],
        });
        compileTimer = setTimeout(compileEditor, 250);
        return;
      }
      if (state.selectedDataType !== null) {
        const dataTypes = state.dataTypes.map((type, index) =>
          index === state.selectedDataType ? deriveDataType(source, type) : type,
        );
        update({ source, dataTypes, diagnostics: [], editorIr: undefined, saveDiagnostics: [] });
        compileTimer = setTimeout(compileEditor, 250);
        return;
      }
      const pous = state.pous.length
        ? state.pous.map((pou, index) => {
            if (index !== state.selectedPou) return pou;
            return { ...derivePou(source, pou), name: pou.name };
          })
        : createPous([source]);
      const previous = state.pous[state.selectedPou];
      const next = pous[state.selectedPou];
      let breakpoints = state.breakpoints;
      if (previous && next) {
        const key = previous.name.toUpperCase();
        breakpoints = { ...breakpoints };
        const lines = mapBreakpointLines(previous.source, source, breakpoints[key] ?? [], changes);
        delete breakpoints[key];
        if (lines.length) breakpoints[key] = lines;
        if (!Object.keys(breakpoints).length) breakpoints = undefined;
        const mapping = lineOrigins.get(key);
        if (mapping) {
          lineOrigins.set(key, {
            ...mapping,
            lines: mapSourceLines(previous.source, source, mapping.lines, changes),
          });
        }
      }
      update({
        source,
        ...reconcileDebugNames(pous, breakpoints),
        diagnostics: [],
        editorIr: undefined,
        saveDiagnostics: [],
      });
      compileTimer = setTimeout(compileEditor, 250);
    },
    runtimeSource() {
      const pou = state.pous[state.selectedPou];
      return { pou: pou ? runtimeName(pou) : undefined, choices: runtimeChoices() };
    },
    breakpointMarkers(): { line: number; active: boolean }[] {
      const pou = state.pous[state.selectedPou];
      if (
        !pou ||
        state.selectedConfiguration ||
        state.selectedDataType !== null ||
        pou.kind === "INTERFACE"
      )
        return [];
      const key = pou.name.toUpperCase();
      const mapping = lineOrigins.get(key);
      const active =
        state.loadedIr && mapping
          ? new Set(haltPoints(state.loadedIr, mapping.name).map((point) => point.line))
          : new Set<number>();
      return (state.breakpoints?.[key] ?? []).map((line) => ({
        line,
        active: active.has(mapping?.lines[line - 1] ?? -1),
      }));
    },
    toggleBreakpoint(line: number) {
      if (state.selectedConfiguration || state.selectedDataType !== null) return;
      const pou = state.pous[state.selectedPou];
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
    selectFrame(index: number) {
      if (state.runtimeState !== "HALT" || !state.halted?.frames[index]) return;
      update(frameSelection(state.halted, index));
    },
    selectInstance(path: string) {
      if (!state.loadedIr || state.selectedConfiguration || state.selectedDataType !== null) return;
      const pou = state.pous[state.selectedPou];
      if (
        !pou ||
        !instancesForSource(state.loadedIr, runtimeName(pou)).some(
          (instance) => instance.path === path,
        )
      )
        return;
      update({ instanceChoices: { ...state.instanceChoices, [pou.name.toUpperCase()]: path } });
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
        ...compileEditorState(
          state.pous,
          pouSources(dataTypes),
          state.project,
          state.cycleMs,
          state.configuration,
        ),
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
        ...compileEditorState(
          state.pous,
          pouSources(dataTypes),
          state.project,
          state.cycleMs,
          state.configuration,
        ),
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
        ...compileEditorState(
          pous,
          pouSources(state.dataTypes),
          state.project,
          state.cycleMs,
          state.configuration,
        ),
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
        ...compileEditorState(
          pous,
          pouSources(state.dataTypes),
          state.project,
          state.cycleMs,
          state.configuration,
        ),
      });
    },
    addClass() {
      clearTimeout(compileTimer);
      const pous = addClass(state.pous, state.dataTypes);
      update({
        pous,
        editorSession: state.editorSession + 1,
        saveDiagnostics: [],
        selectedPou: pous.length - 1,
        selectedConfiguration: false,
        selectedDataType: null,
        source: pous.at(-1)!.source,
        ...compileEditorState(
          pous,
          pouSources(state.dataTypes),
          state.project,
          state.cycleMs,
          state.configuration,
        ),
      });
    },
    addInterface() {
      clearTimeout(compileTimer);
      const pous = addInterface(state.pous, state.dataTypes);
      update({
        pous,
        editorSession: state.editorSession + 1,
        saveDiagnostics: [],
        selectedPou: 0,
        selectedConfiguration: false,
        selectedDataType: null,
        source: pous[0]!.source,
        ...compileEditorState(
          pous,
          pouSources(state.dataTypes),
          state.project,
          state.cycleMs,
          state.configuration,
        ),
      });
    },
    deletePou(index: number) {
      const remaining = deletePou(state.pous, index);
      if (remaining === state.pous) return;
      clearTimeout(compileTimer);
      const key = state.pous[index]!.name.toUpperCase();
      const breakpoints = { ...state.breakpoints };
      delete breakpoints[key];
      const instanceChoices = { ...state.instanceChoices };
      delete instanceChoices[key];
      lineOrigins.delete(key);
      const debugState = reconcileDebugNames(remaining, breakpoints, instanceChoices);
      const pous = debugState.pous;
      const selectedPou =
        state.selectedPou > index
          ? state.selectedPou - 1
          : Math.max(0, Math.min(state.selectedPou, pous.length - 1));
      update({
        ...debugState,
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
        ...compileEditorState(
          pous,
          pouSources(state.dataTypes),
          state.project,
          state.cycleMs,
          state.configuration,
        ),
      });
    },
    loadEditor,
    run() {
      if (state.connection !== "connected" || pendingLoads.length || state.emergencyActive) return;
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
      if (state.connection !== "connected") return;
      if (state.rejection) update({ rejection: null });
      if (message.type === "warmRestart" || message.type === "coldReset")
        update({ retentiveSkipped: [], ...(loadFailed ? { diagnostic: null } : {}) });
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

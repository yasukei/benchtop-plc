import { openPanelProject, serializePanelProject } from "./panel/project.js";
import {
  addFunction,
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
  source: string;
  editorSession: number;
  saveDiagnostics: Diagnostic[];
  layout: PanelLayout;
  emergencyActive: boolean;
  emergencyReleased: boolean;
  loadedSources: string[] | null;
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
  const source = pous[selectedPou]?.source ?? "";
  let state: AppState = {
    source,
    editorSession: 0,
    saveDiagnostics: [],
    pous,
    selectedPou,
    layout: typeof initial === "string" ? [] : initial.layout,
    project: typeof initial === "string" ? null : initial.project,
    emergencyActive: false,
    emergencyReleased: false,
    loadedSources: null,
    diagnostics: compilePous(pous).diagnostics,
    runtimeState: "STOP",
    snapshot: null,
    diagnostic: null,
    rejection: null,
    cycleMs: typeof initial === "string" ? 10 : initial.cycleMs,
    connection: "connected",
  };
  let compileTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingLoads: string[][] = [];
  const listeners = new Set<() => void>();
  const update = (patch: Partial<AppState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const unsubscribe = client.subscribe((event: ClientEvent) => {
    switch (event.type) {
      case "state":
        update({ runtimeState: event.state });
        break;
      case "snapshot":
        // A load publishes an empty, zero-scan snapshot before execution can resume.
        // Ignore scans already queued by the previously loaded program.
        if (pendingLoads.length && event.snapshot.scanCount !== 0) break;
        update({
          ...(pendingLoads.length ? { loadedSources: pendingLoads.shift()! } : {}),
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
    const result = compilePous(state.pous);
    update({ diagnostics: result.diagnostics });
    return result;
  };
  const loadEditor = () => {
    if (state.connection !== "connected") return false;
    const result = compileEditor();
    if (!result.ir) return false;
    pendingLoads.push(pouSources(state.pous));
    update({ snapshot: null, diagnostic: null, rejection: null });
    client.send({ type: "load", ir: result.ir });
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
    const ms = Number(/^PT([0-9.]+)S$/.exec(opened.project.task.interval)?.[1]) * 1000;
    if (!cycleOptions.includes(ms as CycleMs)) return false;
    clearTimeout(compileTimer);
    const pous = createPous(opened.project.pous);
    const selectedPou = initialPouIndex(pous);
    update({
      pous,
      selectedPou,
      editorSession: state.editorSession + 1,
      saveDiagnostics: [],
      source: pous[selectedPou]?.source ?? "",
      layout: opened.layout,
      project: opened.project,
      diagnostics: compilePous(pous).diagnostics,
      cycleMs: ms as CycleMs,
      // Identical editor text can belong to a different project-wide compilation.
      loadedSources: null,
      snapshot: null,
      diagnostic: null,
      rejection: null,
    });
    client.send({ type: "setCycle", ms });
    loadEditor();
    return true;
  };
  return {
    getSnapshot: () => state,
    setLayout(layout: PanelLayout) {
      update({ layout });
    },
    saveProject() {
      const result = serializePanelProject(
        pouSources(state.pous),
        state.layout,
        state.cycleMs,
        state.project,
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
      const pous = state.pous.length
        ? state.pous.map((pou, index) =>
            index === state.selectedPou ? derivePou(source, pou) : pou,
          )
        : createPous([source]);
      update({ source, pous, diagnostics: [], saveDiagnostics: [] });
      compileTimer = setTimeout(compileEditor, 250);
    },
    selectPou(index: number) {
      if (!state.pous[index] || index === state.selectedPou) return;
      update({
        selectedPou: index,
        source: state.pous[index]!.source,
        editorSession: state.editorSession + 1,
      });
    },
    addFunction() {
      clearTimeout(compileTimer);
      const pous = addFunction(state.pous);
      update({
        pous,
        editorSession: state.editorSession + 1,
        saveDiagnostics: [],
        selectedPou: pous.length - 1,
        source: pous.at(-1)!.source,
        diagnostics: compilePous(pous).diagnostics,
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
        source: pous[selectedPou]?.source ?? "",
        diagnostics: compilePous(pous).diagnostics,
      });
    },
    loadEditor,
    run() {
      if (state.connection !== "connected" || pendingLoads.length || state.emergencyActive) return;
      if (state.runtimeState !== "STOP" && state.runtimeState !== "RUN") return;
      if (!sameSources(pouSources(state.pous), state.loadedSources) && !loadEditor()) return;
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
        if (!cycleOptions.includes(message.ms as CycleMs))
          throw new RangeError("Unsupported cycle");
        update({ cycleMs: message.ms as CycleMs });
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

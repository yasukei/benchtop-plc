import { compile } from "@benchtop-plc/compiler";
import type { Project } from "@benchtop-plc/project";
import { openPanelProject, savePanelProject } from "./panel/project.js";
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

export interface AppState {
  source: string;
  layout: PanelLayout;
  project: Project | null;
  emergencyActive: boolean;
  emergencyReleased: boolean;
  loadedSource: string | null;
  diagnostics: Diagnostic[];
  runtimeState: RuntimeState;
  snapshot: RuntimeSnapshot | null;
  diagnostic: Diagnostic | null;
  rejection: CommandRejectionMessage | null;
  cycleMs: CycleMs;
  connection: "connected" | "failed" | "closed";
}

/** A cached snapshot and subscription API suitable for React's useSyncExternalStore. */
export function createAppStore(client: RuntimeClient, initial: string | SavedWork = "") {
  const source = typeof initial === "string" ? initial : initial.source;
  let state: AppState = {
    source,
    layout: typeof initial === "string" ? [] : initial.layout,
    project: typeof initial === "string" ? null : initial.project,
    emergencyActive: false,
    emergencyReleased: false,
    loadedSource: null,
    diagnostics: compile(source).diagnostics,
    runtimeState: "STOP",
    snapshot: null,
    diagnostic: null,
    rejection: null,
    cycleMs: typeof initial === "string" ? 10 : initial.cycleMs,
    connection: "connected",
  };
  let compileTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingLoads: string[] = [];
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
          ...(pendingLoads.length ? { loadedSource: pendingLoads.shift()! } : {}),
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
    const result = compile(state.source);
    update({ diagnostics: result.diagnostics });
    return result;
  };
  const loadEditor = () => {
    if (state.connection !== "connected") return false;
    const result = compileEditor();
    if (!result.ir) return false;
    pendingLoads.push(state.source);
    update({ snapshot: null, diagnostic: null, rejection: null });
    client.send({ type: "load", ir: result.ir });
    return true;
  };
  const openProject = (xml: string) => {
    if (
      pendingLoads.length > 0 ||
      state.runtimeState !== "STOP" ||
      state.emergencyActive ||
      state.connection !== "connected"
    )
      return false;
    const opened = openPanelProject(xml);
    if (!opened || !compile(opened.project.program).ir) return false;
    const ms = Number(/^PT([0-9.]+)S$/.exec(opened.project.task.interval)?.[1]) * 1000;
    if (!cycleOptions.includes(ms as CycleMs)) return false;
    clearTimeout(compileTimer);
    update({
      source: opened.project.program,
      layout: opened.layout,
      project: opened.project,
      diagnostics: compile(opened.project.program).diagnostics,
      cycleMs: ms as CycleMs,
    });
    client.send({ type: "setCycle", ms });
    return loadEditor();
  };
  return {
    getSnapshot: () => state,
    setLayout(layout: PanelLayout) {
      update({ layout });
    },
    saveProject() {
      return savePanelProject(state.source, state.layout, state.cycleMs, state.project);
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
      update({ source, diagnostics: [] });
      compileTimer = setTimeout(compileEditor, 250);
    },
    loadEditor,
    run() {
      if (state.connection !== "connected" || pendingLoads.length || state.emergencyActive) return;
      if (state.runtimeState !== "STOP" && state.runtimeState !== "RUN") return;
      if (state.source !== state.loadedSource && !loadEditor()) return;
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

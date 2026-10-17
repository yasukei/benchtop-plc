import { compile } from "@benchtop-plc/compiler";
import { demoSource } from "./demo.js";
import type {
  CommandRejectionMessage,
  Diagnostic,
  RuntimeSnapshot,
  RuntimeState,
  UiToRuntimeMessage,
} from "@benchtop-plc/core";
import type { ClientEvent, RuntimeClient } from "./runtime-client.js";

export const cycleOptions = [10, 20, 50, 100] as const;
export type CycleMs = (typeof cycleOptions)[number];

export interface AppState {
  source: string;
  loadedSource: string | null;
  diagnostics: Diagnostic[];
  theme: "light" | "dark";
  runtimeState: RuntimeState;
  snapshot: RuntimeSnapshot | null;
  diagnostic: Diagnostic | null;
  rejection: CommandRejectionMessage | null;
  cycleMs: CycleMs;
  connection: "connected" | "failed" | "closed";
}

/** A cached snapshot and subscription API suitable for React's useSyncExternalStore. */
export function createAppStore(client: RuntimeClient, source = demoSource) {
  let state: AppState = {
    source,
    loadedSource: null,
    diagnostics: compile(source).diagnostics,
    theme: "light",
    runtimeState: "STOP",
    snapshot: null,
    diagnostic: null,
    rejection: null,
    cycleMs: 10,
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
  return {
    getSnapshot: () => state,
    setSource(source: string) {
      if (source === state.source) return;
      clearTimeout(compileTimer);
      update({ source, diagnostics: [] });
      compileTimer = setTimeout(compileEditor, 250);
    },
    loadEditor,
    run() {
      if (state.connection !== "connected" || pendingLoads.length) return;
      if (state.runtimeState !== "STOP" && state.runtimeState !== "RUN") return;
      if (state.source !== state.loadedSource && !loadEditor()) return;
      if (state.rejection) update({ rejection: null });
      client.send({ type: "run" });
    },
    setTheme(theme: AppState["theme"]) {
      update({ theme });
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

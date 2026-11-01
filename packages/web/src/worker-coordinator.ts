import type {
  ConfigurationIR,
  HaltedMessage,
  RetentiveRecord,
  UiToRuntimeMessage,
} from "@benchtop-plc/core";
import { haltPoints, mapSourceLines } from "./breakpoints.js";
import { watchedBodies, instancesForSource } from "./instances.js";
import { diagnosticPouIndex, pouSources } from "./pous.js";
import type { RuntimeClient, ClientEvent } from "./runtime-client.js";
import type { StoreState } from "./store-state.js";
import type { SourceMappings } from "./editable-work.js";
import { selectWork } from "./editable-work.js";
import { selectedPouIndex } from "./selection.js";
import { cycleOptions, type CycleMs } from "./cycle.js";

/** Owns Worker protocol ordering, pending acknowledgements and loaded-source mappings. */
export function createWorkerCoordinator(
  client: RuntimeClient,
  getState: () => StoreState,
  update: (patch: Partial<StoreState>) => void,
) {
  let pendingRestore = getState().retentive;
  let awaitingProjectLoad = false;
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
  let lastBodyWatches = "";
  let lastBreakpoints = "";
  const lineOrigins = new Map<string, { name: string; lines: (number | null)[] }>();
  const runtimeName = (pou: { name: string }) =>
    lineOrigins.get(pou.name.toUpperCase())?.name ?? pou.name;
  const runtimeChoices = () => {
    const state = getState();
    const choices = { ...state.instanceChoices };
    for (const pou of state.pous) {
      const path = state.instanceChoices?.[pou.name.toUpperCase()];
      if (path) choices[runtimeName(pou).toUpperCase()] = path;
    }
    return choices;
  };
  const sendBreakpoints = (ir: ConfigurationIR) => {
    const state = getState();
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
    const state = getState();
    if (state.connection !== "connected") return;
    const openPou = state.selection.kind === "pou" ? state.pous[state.selection.index] : undefined;
    const bodies = watchedBodies(ir, runtimeChoices(), openPou ? runtimeName(openPou) : undefined);
    const key = JSON.stringify(bodies);
    if (key !== lastBodyWatches) {
      lastBodyWatches = key;
      client.send({ type: "watchBodies", bodies });
    }
  };
  const frameSelection = (event: HaltedMessage, selectedFrame: number): Partial<StoreState> => {
    const state = getState();
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
            ...selectWork(state, { kind: "pou", index: index! }, true)!.patch,
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
  const load = (ir: ConfigurationIR) => {
    const state = getState();
    if (state.connection !== "connected") return false;
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
        loadedIr: ir,
      },
    });
    update({ snapshot: null, diagnostic: null, rejection: null, retentiveSkipped: [] });
    awaitingProjectLoad = false;
    client.send({
      type: "load",
      loadId,
      ir,
      ...(retentive === undefined ? {} : { retentive }),
    });
    // Queue watches before RUN can activate an event task, without waiting for the load reply.
    sendBodyWatches(ir);
    sendBreakpoints(ir);
    return true;
  };
  const synchronize = () => {
    const state = getState();
    if (state.loadedIr && !pendingLoads.length) {
      sendBodyWatches(state.loadedIr);
      sendBreakpoints(state.loadedIr);
    }
  };
  return {
    load,
    synchronize,
    get loading() {
      return pendingLoads.length > 0;
    },
    replaceProject() {
      pendingRestore = undefined;
      awaitingProjectLoad = true;
    },
    applySourceMappings(mappings: SourceMappings = {}) {
      const { edit, removed, renames } = mappings;
      if (edit) {
        const key = edit.pou.name.toUpperCase();
        const mapping = lineOrigins.get(key);
        if (mapping)
          lineOrigins.set(key, {
            ...mapping,
            lines: mapSourceLines(edit.pou.source, edit.source, mapping.lines, edit.changes),
          });
      }
      if (removed) lineOrigins.delete(removed);
      if (renames?.size) {
        // Read every old entry before writing destinations, so swaps cannot overwrite them.
        const origins = Array.from(
          lineOrigins,
          ([key, mapping]) => [renames.get(key) ?? key, mapping] as const,
        );
        lineOrigins.clear();
        for (const [key, mapping] of origins) lineOrigins.set(key, mapping);
      }
    },
    runtimeSource() {
      const state = getState();
      const pou = state.pous[selectedPouIndex(state.selection)];
      return { pou: pou ? runtimeName(pou) : undefined, choices: runtimeChoices() };
    },
    breakpointMarkers(): { line: number; active: boolean }[] {
      const state = getState();
      const pou = state.pous[selectedPouIndex(state.selection)];
      if (!pou || state.selection.kind !== "pou" || pou.kind === "INTERFACE") return [];
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
    selectFrame(index: number) {
      const state = getState();
      if (state.runtimeState !== "HALT" || !state.halted?.frames[index]) return;
      update(frameSelection(state.halted, index));
    },
    selectInstance(path: string) {
      const state = getState();
      if (!state.loadedIr || state.selection.kind !== "pou") return;
      const pou = state.pous[selectedPouIndex(state.selection)];
      if (
        !pou ||
        !instancesForSource(state.loadedIr, runtimeName(pou)).some(
          (instance) => instance.path === path,
        )
      )
        return;
      update({ instanceChoices: { ...state.instanceChoices, [pou.name.toUpperCase()]: path } });
    },
    send(message: UiToRuntimeMessage) {
      const state = getState();
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
    dispose: unsubscribe,
  };
}

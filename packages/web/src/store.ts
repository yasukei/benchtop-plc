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
  theme: "light" | "dark";
  runtimeState: RuntimeState;
  snapshot: RuntimeSnapshot | null;
  diagnostic: Diagnostic | null;
  rejection: CommandRejectionMessage | null;
  cycleMs: CycleMs;
  connection: "connected" | "failed" | "closed";
}

/** A cached snapshot and subscription API suitable for React's useSyncExternalStore. */
export function createAppStore(client: RuntimeClient) {
  let state: AppState = {
    theme: "light",
    runtimeState: "STOP",
    snapshot: null,
    diagnostic: null,
    rejection: null,
    cycleMs: 10,
    connection: "connected",
  };
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
        update({
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
  return {
    getSnapshot: () => state,
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
      unsubscribe();
      listeners.clear();
    },
  };
}

export type AppStore = ReturnType<typeof createAppStore>;

import type { ShellCatalog } from "./catalog.js";
import type { AppState } from "./store.js";

export interface Banner {
  key: keyof Pick<
    ShellCatalog,
    "connectionError" | "estop" | "fault" | "running" | "info" | "released"
  >;
  urgent: boolean;
}

/** Connection failures take precedence over E-STOP, latched faults and normal status. */
export function bannerFor(
  state: Pick<AppState, "connection" | "runtimeState" | "diagnostic"> &
    Partial<Pick<AppState, "emergencyActive" | "emergencyReleased">>,
): Banner {
  if (state.connection !== "connected") return { key: "connectionError", urgent: true };
  if (state.emergencyActive || state.runtimeState === "ESTOP")
    return { key: "estop", urgent: true };
  if (state.diagnostic || state.runtimeState === "FAULT") return { key: "fault", urgent: true };
  if (state.runtimeState === "RUN") return { key: "running", urgent: false };
  if (state.emergencyReleased) return { key: "released", urgent: false };
  return { key: "info", urgent: false };
}

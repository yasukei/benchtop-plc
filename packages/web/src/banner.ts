import type { ShellCatalog } from "./catalog.js";
import type { AppState } from "./store.js";

export interface Banner {
  key: keyof Pick<ShellCatalog, "connectionError" | "estop" | "fault" | "running" | "info">;
  urgent: boolean;
}

/** Connection failures take precedence over E-STOP, latched faults and normal status. */
export function bannerFor(
  state: Pick<AppState, "connection" | "runtimeState" | "diagnostic">,
): Banner {
  if (state.connection !== "connected") return { key: "connectionError", urgent: true };
  if (state.runtimeState === "ESTOP") return { key: "estop", urgent: true };
  if (state.diagnostic || state.runtimeState === "FAULT") return { key: "fault", urgent: true };
  if (state.runtimeState === "RUN") return { key: "running", urgent: false };
  return { key: "info", urgent: false };
}

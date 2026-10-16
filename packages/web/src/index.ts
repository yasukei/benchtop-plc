/** Stable package identity used by the workspace smoke test. */
export const packageName = "@benchtop-plc/web";
export { RuntimeClient } from "./runtime-client.js";
export type { ClientEvent, RuntimeWorker } from "./runtime-client.js";
export { createAppStore, cycleOptions } from "./store.js";
export type { AppState, AppStore, CycleMs } from "./store.js";

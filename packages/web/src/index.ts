/** Stable package identity used by the workspace smoke test. */
export const packageName = "@benchtop-plc/web";
export { RuntimeClient } from "./runtime-client.js";
export type { ClientEvent, RuntimeWorker } from "./runtime-client.js";
export { createAppStore, cycleOptions } from "./store.js";
export type { AppState, AppStore, CycleMs } from "./store.js";
export { catalogs } from "./catalog.js";
export type { Language, MessageKey, ShellCatalog } from "./catalog.js";
export { createI18n, initialLanguage } from "./i18n.js";
export type { I18n, LanguagePreferences } from "./i18n.js";
export { formatDiagnostic } from "./diagnostic-catalog.js";

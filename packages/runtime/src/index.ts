/** Stable package identity used by the workspace smoke test. */
export const packageName = "@benchtop-plc/runtime";
export * from "./clock.js";
export * from "./library.js";
export * from "./standard-library.js";
export { createStandardFunctionBlock } from "./standard-blocks.js";
export { callStandardFunction } from "./standard-functions.js";
export * from "./runtime.js";
export type { ScanMemory } from "./memory.js";
export { WATCHDOG_LIMIT } from "./interpreter.js";

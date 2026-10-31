/** Stable package identity. */
export const packageName = "@benchtop-plc/runtime";
export * from "./clock.js";
export * from "./library.js";
export * from "./standard-library.js";
export { createStandardFunctionBlock } from "./standard-blocks.js";
export { callStandardFunction } from "./standard-functions.js";
export * from "./runtime.js";
export type { ScanMemory } from "./memory.js";
export type { PauseHook, PauseLocation } from "./interpreter.js";
export { WATCHDOG_LIMIT } from "./interpreter.js";

import type { RuntimeLibrary } from "./library.js";
import { createStandardFunctionBlock } from "./standard-blocks.js";
import { callStandardFunction } from "./standard-functions.js";

/** Stateless dispatch; every created FB owns independent ports and private state. */
export const standardLibrary: RuntimeLibrary = {
  createFunctionBlock: createStandardFunctionBlock,
  callFunction: callStandardFunction,
};

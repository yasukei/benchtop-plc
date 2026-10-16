import type {
  FunctionBlockType,
  StandardFunction,
  TypedValue,
  ScalarValue,
} from "@benchtop-plc/core";

/** Implementations keep private FB state in the instance, recreated on cold reset. */
export interface FunctionBlockInstance {
  inputs: TypedValue[];
  outputs: TypedValue[];
  execute(scanStartMs: number): void;
}

/** Standard implementations and shared port descriptors are supplied by issue #9. */
export interface RuntimeLibrary {
  createFunctionBlock(type: FunctionBlockType): FunctionBlockInstance;
  callFunction(name: StandardFunction, args: readonly ScalarValue[]): ScalarValue;
}

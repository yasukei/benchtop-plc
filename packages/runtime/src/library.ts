import type {
  FunctionBlockType,
  DataType,
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

/** Replaceable dispatch; defaults to the standard library in createRuntime. */
export interface RuntimeLibrary {
  createFunctionBlock(type: FunctionBlockType): FunctionBlockInstance;
  callFunction(
    name: StandardFunction,
    args: readonly ScalarValue[],
    dataType?: DataType,
  ): ScalarValue;
}

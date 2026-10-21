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

/** Call-site types preserve independent factors; outputs are buffered by the interpreter. */
export interface FunctionCallContext {
  argumentTypes: readonly DataType[];
  output(index: number, value: ScalarValue): void;
}

/** Replaceable dispatch; defaults to the standard library in createRuntime. */
export interface RuntimeLibrary {
  createFunctionBlock(type: FunctionBlockType): FunctionBlockInstance;
  callFunction(
    name: StandardFunction,
    args: readonly ScalarValue[],
    dataType?: DataType,
    context?: FunctionCallContext,
  ): ScalarValue;
}

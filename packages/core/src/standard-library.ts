import type { FunctionBlockType, StandardFunction } from "./ir.js";
import type { DataType } from "./values.js";

const numericTypes = ["INT", "UINT", "DINT", "REAL", "LREAL"] as const;
const scalarTypes = ["BOOL", ...numericTypes, "TIME"] as const;

export type FunctionBlockPort = readonly [name: string, type: DataType];
export interface FunctionBlockDescriptor {
  inputs: readonly FunctionBlockPort[];
  outputs: readonly FunctionBlockPort[];
}
const timer = {
  inputs: [
    ["IN", "BOOL"],
    ["PT", "TIME"],
  ],
  outputs: [
    ["Q", "BOOL"],
    ["ET", "TIME"],
  ],
} as const;
const trigger = { inputs: [["CLK", "BOOL"]], outputs: [["Q", "BOOL"]] } as const;
/** Port order is part of the IR contract; compiler and runtime share this registry. */
export const standardFunctionBlocks = {
  TON: timer,
  TOF: timer,
  TP: timer,
  R_TRIG: trigger,
  F_TRIG: trigger,
  CTU: {
    inputs: [
      ["CU", "BOOL"],
      ["R", "BOOL"],
      ["PV", "INT"],
    ],
    outputs: [
      ["Q", "BOOL"],
      ["CV", "INT"],
    ],
  },
  CTD: {
    inputs: [
      ["CD", "BOOL"],
      ["LD", "BOOL"],
      ["PV", "INT"],
    ],
    outputs: [
      ["Q", "BOOL"],
      ["CV", "INT"],
    ],
  },
} as const satisfies Record<FunctionBlockType, FunctionBlockDescriptor>;

type Types = readonly [DataType, ...DataType[]];
export interface StandardFunctionSignature {
  min: number;
  /** null denotes extensible arity. */
  max: number | null;
  /** Positional accepted types; the final entry repeats for additional arguments. */
  arguments: readonly Types[];
  /** Omitted for polymorphic results resolved by the compiler. */
  result?: DataType;
}
export const standardFunctions = {
  ABS: { min: 1, max: 1, arguments: [numericTypes] },
  MIN: { min: 2, max: null, arguments: [numericTypes] },
  MAX: { min: 2, max: null, arguments: [numericTypes] },
  LIMIT: { min: 3, max: 3, arguments: [numericTypes] },
  SEL: { min: 3, max: 3, arguments: [["BOOL"], scalarTypes] },
  REAL_TO_INT: { min: 1, max: 1, arguments: [["REAL"]], result: "INT" },
  INT_TO_REAL: { min: 1, max: 1, arguments: [["INT"]], result: "REAL" },
  TIME_TO_INT: { min: 1, max: 1, arguments: [["TIME"]], result: "INT" },
  INT_TO_TIME: { min: 1, max: 1, arguments: [["INT"]], result: "TIME" },
  BOOL_TO_INT: { min: 1, max: 1, arguments: [["BOOL"]], result: "INT" },
} as const satisfies Record<StandardFunction, StandardFunctionSignature>;

export const isFunctionBlockType = (name: string): name is FunctionBlockType =>
  Object.hasOwn(standardFunctionBlocks, name);
export const isStandardFunction = (name: string): name is StandardFunction =>
  Object.hasOwn(standardFunctions, name);
export const getStandardFunctionSignature = (name: StandardFunction): StandardFunctionSignature =>
  standardFunctions[name];

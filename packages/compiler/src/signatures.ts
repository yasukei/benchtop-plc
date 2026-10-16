import type { DataType, FunctionBlockType, StandardFunction } from "@benchtop-plc/core";
import { numericTypes } from "./type-rules.js";

type Port = readonly [name: string, type: DataType];
interface Block {
  inputs: readonly Port[];
  outputs: readonly Port[];
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
/** Compiler-local until issue #9 supplies the shared core registry. */
export const blocks = {
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
} as const satisfies Record<FunctionBlockType, Block>;

type Types = readonly [DataType, ...DataType[]];
interface Signature {
  min: number;
  max: number | null;
  arguments: readonly Types[];
  result?: DataType;
}
export const functions = {
  ABS: { min: 1, max: 1, arguments: [numericTypes] },
  MIN: { min: 2, max: null, arguments: [numericTypes] },
  MAX: { min: 2, max: null, arguments: [numericTypes] },
  LIMIT: { min: 3, max: 3, arguments: [numericTypes] },
  SEL: { min: 3, max: 3, arguments: [["BOOL"]] },
  REAL_TO_INT: { min: 1, max: 1, arguments: [["REAL"]], result: "INT" },
  INT_TO_REAL: { min: 1, max: 1, arguments: [["INT"]], result: "REAL" },
  TIME_TO_INT: { min: 1, max: 1, arguments: [["TIME"]], result: "INT" },
  INT_TO_TIME: { min: 1, max: 1, arguments: [["INT"]], result: "TIME" },
  BOOL_TO_INT: { min: 1, max: 1, arguments: [["BOOL"]], result: "INT" },
} as const satisfies Record<StandardFunction, Signature>;

export const isBlock = (name: string): name is FunctionBlockType => Object.hasOwn(blocks, name);
export const isFunction = (name: string): name is StandardFunction =>
  Object.hasOwn(functions, name);
export const getSignature = (name: StandardFunction): Signature => functions[name];

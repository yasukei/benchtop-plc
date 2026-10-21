import type { ConversionFunction, FunctionBlockType, StandardFunction } from "./ir.js";
import { integerTypes as integers } from "./values.js";
import type { DataType } from "./values.js";

const numericTypes = [...integers, "REAL", "LREAL"] as const;
const bits = ["BOOL", "BYTE", "WORD", "DWORD", "LWORD"] as const;
const bitStrings = ["BYTE", "WORD", "DWORD", "LWORD"] as const;
const scalarTypes = [...bits, ...numericTypes, "TIME", "LTIME"] as const;

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
const conversionEntries: [string, StandardFunctionSignature][] = [];
for (const to of scalarTypes) {
  const sources: Types =
    to === "TIME" || to === "LTIME"
      ? [...integers, "TIME", "LTIME"]
      : to === "BOOL"
        ? bits
        : bitStrings.some((type) => type === to)
          ? [
              ...bits,
              ...integers,
              ...(to === "DWORD" ? ["REAL" as const] : to === "LWORD" ? ["LREAL" as const] : []),
            ]
          : to === "REAL"
            ? [...numericTypes, "DWORD"]
            : to === "LREAL"
              ? [...numericTypes, "LWORD"]
              : [...numericTypes, ...bits, "TIME", "LTIME"];
  conversionEntries.push([`TO_${to}`, { min: 1, max: 1, arguments: [sources], result: to }]);
  for (const from of sources) {
    if (from !== to)
      conversionEntries.push([
        `${from}_TO_${to}`,
        {
          min: 1,
          max: 1,
          arguments: [[from]],
          result: to,
        },
      ]);
  }
}
// Every conversion opcode is generated from the families in ConversionFunction.
export const conversionFunctions = Object.fromEntries(conversionEntries) as Record<
  ConversionFunction,
  StandardFunctionSignature
>;
export const standardFunctions = {
  ABS: { min: 1, max: 1, arguments: [numericTypes] },
  MIN: { min: 2, max: null, arguments: [numericTypes] },
  MAX: { min: 2, max: null, arguments: [numericTypes] },
  LIMIT: { min: 3, max: 3, arguments: [numericTypes] },
  SEL: { min: 3, max: 3, arguments: [["BOOL"], scalarTypes] },
  ...conversionFunctions,
} as const satisfies Record<StandardFunction, StandardFunctionSignature>;

export const isFunctionBlockType = (name: string): name is FunctionBlockType =>
  Object.hasOwn(standardFunctionBlocks, name);
export const isStandardFunction = (name: string): name is StandardFunction =>
  Object.hasOwn(standardFunctions, name);
export const getStandardFunctionSignature = (name: StandardFunction): StandardFunctionSignature =>
  standardFunctions[name];

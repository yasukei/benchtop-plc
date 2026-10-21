import type {
  BcdFunction,
  TruncationFunction,
  ConversionFunction,
  FunctionBlockType,
  CounterType,
  StandardFunction,
  TimeArithmeticFunction,
  CalendarFunction,
} from "./ir.js";
import { integerTypes as integers } from "./values.js";
import { calendarTypes } from "./calendar.js";
import type { DataType } from "./values.js";

const numericTypes = [...integers, "REAL", "LREAL"] as const;
const bits = ["BOOL", "BYTE", "WORD", "DWORD", "LWORD"] as const;
const bitStrings = ["BYTE", "WORD", "DWORD", "LWORD"] as const;
const scalarTypes = [...bits, ...numericTypes, "TIME", "LTIME", ...calendarTypes] as const;

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
const longTimer = {
  inputs: [
    ["IN", "BOOL"],
    ["PT", "LTIME"],
  ],
  outputs: [
    ["Q", "BOOL"],
    ["ET", "LTIME"],
  ],
} as const;
const trigger = { inputs: [["CLK", "BOOL"]], outputs: [["Q", "BOOL"]] } as const;
function counter(type: CounterType, kind: "CTU" | "CTD" | "CTUD"): FunctionBlockDescriptor {
  return {
    inputs:
      kind === "CTUD"
        ? [
            ["CU", "BOOL"],
            ["CD", "BOOL"],
            ["R", "BOOL"],
            ["LD", "BOOL"],
            ["PV", type],
          ]
        : [
            [kind === "CTU" ? "CU" : "CD", "BOOL"],
            [kind === "CTU" ? "R" : "LD", "BOOL"],
            ["PV", type],
          ],
    outputs:
      kind === "CTUD"
        ? [
            ["QU", "BOOL"],
            ["QD", "BOOL"],
            ["CV", type],
          ]
        : [
            ["Q", "BOOL"],
            ["CV", type],
          ],
  };
}
const typedCounterEntries = (["CTU", "CTD", "CTUD"] as const).flatMap((kind) =>
  (["INT", "DINT", "LINT", "UDINT", "ULINT"] as const).map(
    (type) => [`${kind}_${type}`, counter(type, kind)] as const,
  ),
);
const typedCounters = Object.fromEntries(typedCounterEntries) as Record<
  `${"CTU" | "CTD" | "CTUD"}_${CounterType}`,
  FunctionBlockDescriptor
>;
/** Port order is part of the IR contract; compiler and runtime share this registry. */
export const standardFunctionBlocks = {
  TON: timer,
  TOF: timer,
  TP: timer,
  TON_TIME: timer,
  TOF_TIME: timer,
  TP_TIME: timer,
  TON_LTIME: longTimer,
  TOF_LTIME: longTimer,
  TP_LTIME: longTimer,
  R_TRIG: trigger,
  F_TRIG: trigger,
  SR: {
    inputs: [
      ["S1", "BOOL"],
      ["R", "BOOL"],
    ],
    outputs: [["Q1", "BOOL"]],
  },
  RS: {
    inputs: [
      ["S", "BOOL"],
      ["R1", "BOOL"],
    ],
    outputs: [["Q1", "BOOL"]],
  },
  CTU: counter("INT", "CTU"),
  CTD: counter("INT", "CTD"),
  CTUD: counter("INT", "CTUD"),
  ...typedCounters,
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
  /** Arguments from this index onward form one common-type group. */
  genericStart?: number;
  /** Independent parameters: result takes this argument's type. */
  resultArgument?: number;
  inputNames?: readonly string[];
  outputs?: readonly FunctionBlockPort[];
  /** Named time arithmetic shares the corresponding operator's exact implementation. */
  operator?: "+" | "-" | "*" | "/";
}
const conversionEntries: [string, StandardFunctionSignature][] = [];
for (const to of [...bits, ...numericTypes, "TIME", "LTIME"] as const) {
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
const calendarSources = {
  DATE: ["DT", "LDT", "LDATE"],
  LDATE: ["DATE", "LDT"],
  TOD: ["DT", "LDT", "LTOD"],
  LTOD: ["DT", "LDT", "TOD"],
  DT: ["LDT"],
  LDT: ["DT"],
} as const;
for (const to of calendarTypes) {
  const sources = calendarSources[to];
  conversionEntries.push([
    `TO_${to}`,
    { min: 1, max: 1, arguments: [[to, ...sources]], result: to },
  ]);
  for (const from of sources)
    conversionEntries.push([
      `${from}_TO_${to}`,
      { min: 1, max: 1, arguments: [[from]], result: to },
    ]);
}
// Every conversion opcode is generated from the families in ConversionFunction.
export const conversionFunctions = Object.fromEntries(conversionEntries) as Record<
  ConversionFunction,
  StandardFunctionSignature
>;
const reals = ["REAL", "LREAL"] as const;
const truncationEntries: [string, StandardFunctionSignature][] = [];
const bcdEntries: [string, StandardFunctionSignature][] = [];
for (const to of integers) {
  truncationEntries.push([`TRUNC_${to}`, { min: 1, max: 1, arguments: [reals], result: to }]);
  for (const from of reals)
    truncationEntries.push([
      `${from}_TRUNC_${to}`,
      { min: 1, max: 1, arguments: [[from]], result: to },
    ]);
  for (const bits of bitStrings) {
    bcdEntries.push([`${bits}_BCD_TO_${to}`, { min: 1, max: 1, arguments: [[bits]], result: to }]);
    bcdEntries.push([`${to}_TO_BCD_${bits}`, { min: 1, max: 1, arguments: [[to]], result: bits }]);
  }
}
export const truncationFunctions = Object.fromEntries(truncationEntries) as Record<
  TruncationFunction,
  StandardFunctionSignature
>;
export const bcdFunctions = Object.fromEntries(bcdEntries) as Record<
  BcdFunction,
  StandardFunctionSignature
>;
const generic = (types: Types, min: number, max: number | null): StandardFunctionSignature => ({
  min,
  max,
  arguments: [types],
  genericStart: 0,
});
const realUnary = generic(reals, 1, 1);
const shift: StandardFunctionSignature = {
  min: 2,
  max: 2,
  arguments: [bits, integers],
  resultArgument: 0,
};
const comparison: StandardFunctionSignature = { ...generic(scalarTypes, 2, null), result: "BOOL" };
const timeEntries: [string, StandardFunctionSignature][] = [];
for (const long of [false, true]) {
  const duration = long ? "LTIME" : "TIME";
  const tod = long ? "LTOD" : "TOD";
  const dt = long ? "LDT" : "DT";
  const date = long ? "LDATE" : "DATE";
  const arithmetic = (
    name: string,
    left: DataType,
    right: Types,
    result: DataType,
    operator: "+" | "-" | "*" | "/",
  ) =>
    timeEntries.push([
      name,
      {
        min: 2,
        max: 2,
        arguments: [[left], right],
        result,
        operator,
        inputNames: ["IN1", "IN2"],
      },
    ]);
  arithmetic(`ADD_${duration}`, duration, [duration], duration, "+");
  arithmetic(`SUB_${duration}`, duration, [duration], duration, "-");
  for (const type of [tod, dt] as const) {
    arithmetic(`ADD_${type}_${duration}`, type, [duration], type, "+");
    arithmetic(`SUB_${type}_${duration}`, type, [duration], type, "-");
    arithmetic(`SUB_${type}_${type}`, type, [type], duration, "-");
  }
  arithmetic(`SUB_${date}_${date}`, date, [date], duration, "-");
  arithmetic(`MUL_${duration}`, duration, numericTypes, duration, "*");
  arithmetic(`DIV_${duration}`, duration, numericTypes, duration, "/");
}
export const timeArithmeticFunctions = Object.fromEntries(timeEntries) as Record<
  TimeArithmeticFunction,
  StandardFunctionSignature
>;
const dateFields = ["YEAR", "MONTH", "DAY"] as const;
const timeFields = ["HOUR", "MINUTE", "SECOND", "MILLISECOND"] as const;
const components = (result: DataType, names: readonly string[]): StandardFunctionSignature => ({
  min: names.length,
  max: names.length,
  arguments: [integers],
  result,
  inputNames: names,
});
const split = (type: DataType, names: readonly string[]): StandardFunctionSignature => ({
  min: 1,
  max: 1,
  arguments: [[type]],
  result: "BOOL",
  inputNames: ["IN"],
  outputs: names.map((name) => [name, "INT"] as const),
});
export const calendarFunctions = {
  CONCAT_DATE_TOD: {
    min: 2,
    max: 2,
    arguments: [["DATE"], ["TOD"]],
    result: "DT",
    inputNames: ["IN1", "IN2"],
  },
  CONCAT_DATE_LTOD: {
    min: 2,
    max: 2,
    arguments: [["DATE", "LDATE"], ["LTOD"]],
    result: "LDT",
    inputNames: ["IN1", "IN2"],
  },
  CONCAT_DATE: components("DATE", dateFields),
  CONCAT_TOD: components("TOD", timeFields),
  CONCAT_LTOD: components("LTOD", timeFields),
  CONCAT_DT: components("DT", [...dateFields, ...timeFields]),
  CONCAT_LDT: components("LDT", [...dateFields, ...timeFields]),
  SPLIT_DATE: { ...split("DATE", dateFields), arguments: [["DATE", "LDATE"]] },
  SPLIT_TOD: split("TOD", timeFields),
  SPLIT_LTOD: split("LTOD", timeFields),
  SPLIT_DT: split("DT", [...dateFields, ...timeFields]),
  SPLIT_LDT: split("LDT", [...dateFields, ...timeFields]),
  DAY_OF_WEEK: {
    min: 1,
    max: 1,
    arguments: [["DATE", "LDATE"]],
    result: "INT",
    inputNames: ["IN"],
  },
} as const satisfies Record<CalendarFunction, StandardFunctionSignature>;

export const standardFunctions = {
  ABS: generic(numericTypes, 1, 1),
  SQRT: realUnary,
  LN: realUnary,
  LOG: realUnary,
  EXP: realUnary,
  SIN: realUnary,
  COS: realUnary,
  TAN: realUnary,
  ASIN: realUnary,
  ACOS: realUnary,
  ATAN: realUnary,
  ATAN2: generic(reals, 2, 2),
  ADD: generic(numericTypes, 2, null),
  MUL: generic(numericTypes, 2, null),
  SUB: generic(numericTypes, 2, 2),
  DIV: generic(numericTypes, 2, 2),
  MOD: generic(integers, 2, 2),
  EXPT: { min: 2, max: 2, arguments: [reals, numericTypes], resultArgument: 0 },
  MOVE: generic(scalarTypes, 1, 1),
  SHL: shift,
  SHR: shift,
  ROL: shift,
  ROR: shift,
  AND: generic(bits, 2, null),
  OR: generic(bits, 2, null),
  XOR: generic(bits, 2, null),
  NOT: generic(bits, 1, 1),
  MIN: generic(scalarTypes, 2, null),
  MAX: generic(scalarTypes, 2, null),
  LIMIT: generic(scalarTypes, 3, 3),
  SEL: { min: 3, max: 3, arguments: [["BOOL"], scalarTypes], genericStart: 1 },
  MUX: { min: 3, max: null, arguments: [integers, scalarTypes], genericStart: 1 },
  GT: comparison,
  GE: comparison,
  EQ: comparison,
  LE: comparison,
  LT: comparison,
  NE: { ...comparison, max: 2 },
  ...timeArithmeticFunctions,
  ...calendarFunctions,
  ...truncationFunctions,
  ...bcdFunctions,
  ...conversionFunctions,
} as const satisfies Record<StandardFunction, StandardFunctionSignature>;

export const isFunctionBlockType = (name: string): name is FunctionBlockType =>
  Object.hasOwn(standardFunctionBlocks, name);
export const isStandardFunction = (name: string): name is StandardFunction =>
  Object.hasOwn(standardFunctions, name);
export const getStandardFunctionSignature = (name: StandardFunction): StandardFunctionSignature =>
  standardFunctions[name];

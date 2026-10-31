import type {
  BcdFunction,
  TruncationFunction,
  ConversionFunction,
  FunctionBlockType,
  CounterType,
  StandardFunction,
  TimeArithmeticFunction,
  CalendarFunction,
  StringFunction,
} from "./ir.js";
import { integerTypes as integers } from "./values.js";
import { calendarTypes } from "./calendar.js";
import type { DataType } from "./values.js";

const numericTypes = [...integers, "REAL", "LREAL"] as const;
const bits = ["BOOL", "BYTE", "WORD", "DWORD", "LWORD"] as const;
const bitStrings = ["BYTE", "WORD", "DWORD", "LWORD"] as const;
const scalarTypes = [
  ...bits,
  ...numericTypes,
  "TIME",
  "LTIME",
  ...calendarTypes,
  "STRING",
  "WSTRING",
  "CHAR",
  "WCHAR",
] as const;

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
  /** Exclusive end of the common-type group; omitted means all remaining arguments. */
  genericEnd?: number;
  /** Independent parameters: result takes this argument's type. */
  resultArgument?: number;
  /** Formal inputs in positional order; the final numbered name continues its sequence for extensible arity. */
  inputNames?: readonly string[];
  outputs?: readonly FunctionBlockPort[];
  /** Named time arithmetic shares the corresponding operator's exact implementation. */
  operator?: "+" | "-" | "*" | "/";
}
// IEC 61131-3 standard function tables: unary/conversion input is IN.
const unary = (types: Types, result: DataType): StandardFunctionSignature => ({
  min: 1,
  max: 1,
  arguments: [types],
  result,
  inputNames: ["IN"],
});
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
  conversionEntries.push([`TO_${to}`, unary(sources, to)]);
  for (const from of sources) {
    if (from !== to) conversionEntries.push([`${from}_TO_${to}`, unary([from], to)]);
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
  conversionEntries.push([`TO_${to}`, unary([to, ...sources], to)]);
  for (const from of sources) conversionEntries.push([`${from}_TO_${to}`, unary([from], to)]);
}
// String conversions extend the existing overloaded destination signatures.
const textTypes = ["STRING", "WSTRING"] as const;
const plainTypes = scalarTypes.filter(
  (type) => !["STRING", "WSTRING", "CHAR", "WCHAR"].includes(type),
);
const characterPairs = [
  ["STRING", "WSTRING"],
  ["WSTRING", "STRING"],
  ["CHAR", "STRING"],
  ["WCHAR", "WSTRING"],
  ["STRING", "CHAR"],
  ["WSTRING", "WCHAR"],
  ["CHAR", "WCHAR"],
  ["WCHAR", "CHAR"],
  ["CHAR", "BYTE"],
  ["BYTE", "CHAR"],
  ["WCHAR", "WORD"],
  ["WORD", "WCHAR"],
] as const;
const stringPairs: readonly (readonly [DataType, DataType])[] = [
  ...textTypes.flatMap((text) =>
    plainTypes.flatMap(
      (type) =>
        [
          [type, text],
          [text, type],
        ] as const,
    ),
  ),
  ...characterPairs,
];
for (const [from, to] of stringPairs) {
  conversionEntries.push([`${from}_TO_${to}`, unary([from], to)]);
  const overloaded = conversionEntries.find(([name]) => name === `TO_${to}`);
  if (overloaded) {
    const sources = overloaded[1].arguments[0]!;
    if (!sources.includes(from)) overloaded[1].arguments = [[...sources, from]];
  } else conversionEntries.push([`TO_${to}`, unary([from, to], to)]);
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
  truncationEntries.push([`TRUNC_${to}`, unary(reals, to)]);
  for (const from of reals) truncationEntries.push([`${from}_TRUNC_${to}`, unary([from], to)]);
  for (const bits of bitStrings) {
    bcdEntries.push([`${bits}_BCD_TO_${to}`, unary([bits], to)]);
    bcdEntries.push([`${to}_TO_BCD_${bits}`, unary([to], bits)]);
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
const generic = (
  types: Types,
  min: number,
  max: number | null,
  inputNames: readonly string[] = min === 1 ? ["IN"] : ["IN1", "IN2"],
): StandardFunctionSignature => ({
  min,
  max,
  arguments: [types],
  genericStart: 0,
  inputNames,
});
const realUnary = generic(reals, 1, 1);
const shift: StandardFunctionSignature = {
  min: 2,
  max: 2,
  arguments: [bits, integers],
  resultArgument: 0,
  inputNames: ["IN", "N"],
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

const strings = ["STRING", "WSTRING"] as const;
export const stringFunctions = {
  LEN: unary(strings, "INT"),
  LEFT: {
    min: 2,
    max: 2,
    arguments: [strings, integers],
    resultArgument: 0,
    inputNames: ["IN", "L"],
  },
  RIGHT: {
    min: 2,
    max: 2,
    arguments: [strings, integers],
    resultArgument: 0,
    inputNames: ["IN", "L"],
  },
  MID: {
    min: 3,
    max: 3,
    arguments: [strings, integers, integers],
    resultArgument: 0,
    inputNames: ["IN", "L", "P"],
  },
  CONCAT: generic(strings, 2, null),
  INSERT: {
    min: 3,
    max: 3,
    arguments: [strings, strings, integers],
    inputNames: ["IN1", "IN2", "P"],
    genericStart: 0,
    genericEnd: 2,
  },
  DELETE: {
    min: 3,
    max: 3,
    arguments: [strings, integers, integers],
    resultArgument: 0,
    inputNames: ["IN", "L", "P"],
  },
  REPLACE: {
    min: 4,
    max: 4,
    arguments: [strings, strings, integers, integers],
    inputNames: ["IN1", "IN2", "L", "P"],
    genericStart: 0,
    genericEnd: 2,
  },
  FIND: { ...generic(strings, 2, 2), result: "INT" },
} as const satisfies Record<StringFunction, StandardFunctionSignature>;

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
  ATAN2: generic(reals, 2, 2, ["Y", "X"]),
  ADD: generic(numericTypes, 2, null),
  MUL: generic(numericTypes, 2, null),
  SUB: generic(numericTypes, 2, 2),
  DIV: generic(numericTypes, 2, 2),
  MOD: generic(integers, 2, 2),
  EXPT: {
    min: 2,
    max: 2,
    arguments: [reals, numericTypes],
    resultArgument: 0,
    inputNames: ["IN1", "IN2"],
  },
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
  LIMIT: generic(scalarTypes, 3, 3, ["MN", "IN", "MX"]),
  SEL: {
    min: 3,
    max: 3,
    arguments: [["BOOL"], scalarTypes],
    genericStart: 1,
    inputNames: ["G", "IN0", "IN1"],
  },
  MUX: {
    min: 3,
    max: null,
    arguments: [integers, scalarTypes],
    genericStart: 1,
    inputNames: ["K", "IN0", "IN1"],
  },
  GT: comparison,
  GE: comparison,
  EQ: comparison,
  LE: comparison,
  LT: comparison,
  NE: { ...comparison, max: 2 },
  ...stringFunctions,
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

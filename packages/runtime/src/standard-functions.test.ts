import { describe, expect, it } from "vitest";
import type { ScalarValue, StandardFunction } from "@benchtop-plc/core";
import { callStandardFunction as call } from "./standard-functions.js";

describe("standard functions", () => {
  it.each<[StandardFunction, ScalarValue[], ScalarValue]>([
    ["ABS", [-42], 42],
    ["ABS", [0], 0],
    ["ABS", [-1.25], 1.25],
    ["MIN", [2, -4, 1, -4, 3], -4],
    ["MAX", [-3, -1.5, -5], -1.5],
    ["LIMIT", [0, -1, 10], 0],
    ["LIMIT", [0, 11, 10], 10],
    ["LIMIT", [0, 5, 10], 5],
    ["LIMIT", [2, 2, 2], 2],
    ["LIMIT", [-2.5, -3, -1.5], -2.5],
    ["LIMIT", [10, 5, 0], 0],
    ["SEL", [false, 3, 4], 3],
    ["SEL", [true, 3, 4], 4],
    ["SEL", [true, true, false], false],
    ["SEL", [false, -1000, 1000], -1000],
    ["INT_TO_REAL", [-32768], -32768],
    ["INT_TO_REAL", [32767], 32767],
    ["TIME_TO_INT", [1234], 1234],
    ["TIME_TO_INT", [-1234], -1234],
    ["TIME_TO_INT", [32768], -32768],
    ["INT_TO_TIME", [-32768], -32768],
    ["INT_TO_TIME", [32767], 32767],
    ["BOOL_TO_INT", [false], 0],
    ["BOOL_TO_INT", [true], 1],
  ])("%s(%j) = %s", (name, args, expected) => {
    expect(call(name, args)).toBe(expected);
  });

  it.each([
    [1.49, 1],
    [1.5, 2],
    [2.5, 2],
    [3.5, 4],
    [-1.49, -1],
    [-1.5, -2],
    [-2.5, -2],
    [-3.5, -4],
    [0.5, 0],
    [-0.5, 0],
    [32767.5, -32768],
    [-32768.5, -32768],
    // A REAL argument is binary32 even when its literal retains binary64 precision.
    [2.50000001, 2],
  ])("REAL_TO_INT(%s) rounds to even and wraps to INT: %s", (value, expected) => {
    expect(call("REAL_TO_INT", [value])).toBe(expected);
  });

  it("does not mutate argument arrays", () => {
    const args = Object.freeze([4, 2, 3]);
    expect(call("MIN", args)).toBe(2);
    expect(args).toEqual([4, 2, 3]);
  });

  it("rejects wrong arity and non-finite values", () => {
    expect(() => call("ABS", [])).toThrow("argument count");
    expect(() => call("SEL", [false, 1])).toThrow("argument count");
    expect(() => call("LIMIT", [1, 2, 3, 4])).toThrow("argument count");
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => call("ABS", [value])).toThrow(RangeError);
    }
    expect(() => call("REAL_TO_INT", [1e39])).toThrow(RangeError);
  });
});

describe("numeric and elementary function families", () => {
  it.each<[StandardFunction, number[], number]>([
    ["SQRT", [9], 3],
    ["LN", [Math.E], 1],
    ["LOG", [100], 2],
    ["EXP", [1], Math.E],
    ["SIN", [Math.PI / 2], 1],
    ["COS", [0], 1],
    ["TAN", [0], 0],
    ["ASIN", [1], Math.PI / 2],
    ["ACOS", [1], 0],
    ["ATAN", [1], Math.PI / 4],
    ["ATAN2", [1, -1], (3 * Math.PI) / 4],
    ["EXPT", [2, 10], 1024],
    ["ADD", [1, 2, 3], 6],
    ["MUL", [2, 3, 4], 24],
    ["SUB", [3, 5], -2],
    ["DIV", [7, 2], 3.5],
    ["MOD", [-7, 2], -1],
    ["MOD", [7, 0], 0],
  ])("executes %s", (name, args, result) => {
    expect(Number(call(name, args, "LREAL"))).toBeCloseTo(result, 14);
  });

  it.each<[StandardFunction, ScalarValue[], ScalarValue]>([
    ["AND", [true, false, true], false],
    ["OR", [false, false, true], true],
    ["XOR", [true, true, true], true],
    ["NOT", [true], false],
    ["MAX", [false, true], true],
    ["MIN", [true, false], false],
    ["LIMIT", [false, true, true], true],
    ["MOVE", ["9007199254740993"], "9007199254740993"],
    ["MUX", [1, 10, 20, 30], 20],
    ["MUX", ["0", false, true], false],
    ["GT", [3, 2, 1], true],
    ["GE", [3, 3, 1], true],
    ["EQ", [2, 2, 2], true],
    ["LE", [1, 1, 2], true],
    ["LT", [1, 2, 3], true],
    ["NE", [false, true], true],
    ["GT", [3, 1, 2], false],
    ["GE", [3, 1, 2], false],
    ["EQ", [2, 2, 3], false],
    ["LE", [1, 3, 2], false],
    ["LT", [1, 1, 2], false],
    ["NE", [2, 2], false],
    ["LT", ["9007199254740992", "9007199254740993"], true],
  ])("executes %s(%j)", (name, args, result) => {
    expect(call(name, args)).toBe(result);
  });

  it("rounds REAL intermediates and wraps exact integer results", () => {
    expect(call("ADD", [16777216, 1, -16777216], "REAL")).toBe(0);
    expect(call("ADD", [16777216, 1, -16777216], "LREAL")).toBe(1);
    expect(call("MUL", [4294967295, 4294967295], "UDINT")).toBe(1);
    expect(call("DIV", [-7, 2], "INT")).toBe(-3);
    expect(call("DIV", ["-9223372036854775808", "-1"], "LINT")).toBe("-9223372036854775808");
    expect(call("MUL", ["18446744073709551615", "18446744073709551615"], "ULINT")).toBe("1");
    expect(call("ABS", ["-9223372036854775808"], "LINT")).toBe("-9223372036854775808");
    expect(call("NOT", [4294967295], "DWORD")).toBe(0);
    expect(call("AND", ["18446744073709551615", "9223372036854775809"], "LWORD")).toBe(
      "9223372036854775809",
    );
  });

  it.each(["BOOL", "BYTE", "WORD", "DWORD", "LWORD"] as const)(
    "shifts and rotates at %s width",
    (type) => {
      const widths = { BOOL: 1, BYTE: 8, WORD: 16, DWORD: 32, LWORD: 64 };
      const width = BigInt(widths[type]);
      const input =
        type === "BOOL"
          ? true
          : type === "LWORD"
            ? "9223372036854775809"
            : Number((1n << (width - 1n)) | 1n);
      const asBig = (value: ScalarValue) => BigInt(value);
      const expectedRotate = type === "BOOL" ? 1n : 3n;
      expect(asBig(call("ROL", [input, 1], type))).toBe(expectedRotate);
      expect(asBig(call("ROR", [call("ROL", [input, 1], type), 1], type))).toBe(asBig(input));
      expect(asBig(call("ROL", [input, String(width)], type))).toBe(asBig(input));
      expect(asBig(call("ROR", [input, String(width)], type))).toBe(asBig(input));
      expect(asBig(call("SHL", [input, 1], type))).toBe(type === "BOOL" ? 0n : 2n);
      expect(asBig(call("SHR", [input, 1], type))).toBe(asBig(input) >> 1n);
      for (const name of ["SHL", "SHR"] as const) {
        expect(asBig(call(name, [input, String(width)], type))).toBe(0n);
        expect(asBig(call(name, [input, "18446744073709551615"], type))).toBe(0n);
        expect(asBig(call(name, [input, 0], type))).toBe(asBig(input));
      }
      for (const name of ["SHL", "SHR", "ROL", "ROR"] as const)
        expect(() => call(name, [input, -1], type)).toThrow(RangeError);
    },
  );

  it.each(["SINT", "USINT", "INT", "UINT", "DINT", "UDINT", "LINT", "ULINT"] as const)(
    "truncates and wraps to %s",
    (type) => {
      const negative = ["USINT", "UINT", "UDINT", "ULINT"].includes(type);
      const expected =
        type === "LINT"
          ? "-2"
          : type === "ULINT"
            ? "18446744073709551614"
            : negative
              ? ({ USINT: 254, UINT: 65534, UDINT: 4294967294 } as Record<string, number>)[type]
              : -2;
      expect(call(`TRUNC_${type}`, [-2.7])).toBe(expected);
      expect(call(`REAL_TRUNC_${type}`, [-2.7])).toBe(expected);
      expect(call(`LREAL_TRUNC_${type}`, [-2.7])).toBe(expected);
    },
  );

  it("truncates the source precision and handles huge finite values exactly", () => {
    expect(call("REAL_TRUNC_INT", [1.99999999])).toBe(2);
    expect(call("LREAL_TRUNC_INT", [1.99999999])).toBe(1);
    expect(call("TRUNC_INT", [1e100])).toBe(0);
    expect(call("TRUNC_INT", [40000.9])).toBe(-25536);
  });

  it("encodes, decodes and wraps BCD with exact 64-bit operands", () => {
    expect(call("USINT_TO_BCD_BYTE", [99])).toBe(0x99);
    expect(call("WORD_BCD_TO_UINT", [0x1234])).toBe(1234);
    expect(call("ULINT_TO_BCD_LWORD", ["9999999999999999"])).toBe("11068046444225730969");
    expect(call("LWORD_BCD_TO_ULINT", ["11068046444225730969"])).toBe("9999999999999999");
    expect(call("UINT_TO_BCD_BYTE", [1234])).toBe(0x34);
    expect(call("WORD_BCD_TO_USINT", [0x9999])).toBe(15);
    expect(call("BYTE_BCD_TO_INT", [0])).toBe(0);
    expect(() => call("INT_TO_BCD_WORD", [-1])).toThrow(RangeError);
    expect(() => call("LWORD_BCD_TO_ULINT", ["11529215046068469760"])).toThrow(RangeError);
  });

  it.each<[StandardFunction, ScalarValue[]]>([
    ["SQRT", [-1]],
    ["LN", [0]],
    ["LOG", [-1]],
    ["EXP", [1000]],
    ["ASIN", [2]],
    ["ACOS", [-2]],
    ["EXPT", [-1, 0.5]],
    ["DIV", [1, 0]],
    ["MUX", [-1, 10, 20]],
    ["MUX", [2, 10, 20]],
    ["BYTE_BCD_TO_INT", [0x1a]],
  ])("rejects invalid %s values", (name, args) => {
    expect(() => call(name, args)).toThrow(RangeError);
  });
});

it.each([
  ["REAL_TO_LINT", "2"],
  ["LREAL_TO_LINT", "2"],
  ["TRUNC_LINT", "1"],
  ["REAL_TRUNC_LINT", "1"],
  ["LREAL_TRUNC_LINT", "1"],
] as const)(
  "keeps real inputs intact for %s without optional argument context",
  (name, expected) => {
    expect(call(name, [1.5], "LINT")).toBe(expected);
  },
);

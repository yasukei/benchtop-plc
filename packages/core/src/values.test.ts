import { describe, expect, expectTypeOf, it } from "vitest";
import {
  coerceBool,
  coerceInt,
  coerceUint,
  coerceDint,
  coerceReal,
  coerceLreal,
  coerceTime,
  coerceValue,
  formatTime,
  formatValue,
} from "./index.js";
import type { DataType } from "./index.js";

describe("elementary value coercion", () => {
  it.each([
    [false, false],
    [true, true],
    [0, false],
    [-0, false],
    [1, true],
    [-2, true],
    [0.5, true],
  ])("coerces BOOL %s to %s", (input, expected) => {
    expect(coerceBool(input)).toBe(expected);
  });

  it.each([
    [32767, 32767],
    [32768, -32768],
    [-32768, -32768],
    [-32769, 32767],
    [65536, 0],
    [65535, -1],
    [-65537, -1],
    [1.9, 1],
    [-1.9, -1],
    [true, 1],
    [false, 0],
  ])("coerces INT %s to %s", (input, expected) => {
    expect(coerceInt(input)).toBe(expected);
  });

  it.each([
    [0, 0],
    [65535, 65535],
    [65536, 0],
    [-1, 65535],
    [-65536, 0],
    [1.9, 1],
    [-1.9, 65535],
    [true, 1],
    [false, 0],
  ])("coerces UINT %s to %s", (input, expected) => {
    expect(coerceUint(input)).toBe(expected);
  });

  it.each([
    [2147483647, 2147483647],
    [2147483648, -2147483648],
    [-2147483648, -2147483648],
    [-2147483649, 2147483647],
    [4294967296, 0],
    [4294967295, -1],
    [1.9, 1],
    [-1.9, -1],
    [true, 1],
    [false, 0],
  ])("coerces DINT %s to %s", (input, expected) => {
    expect(coerceDint(input)).toBe(expected);
  });

  it("rounds REAL to float32, retaining LREAL double precision", () => {
    expect(coerceReal(1.337)).toBe(Math.fround(1.337));
    expect(coerceReal(16777217)).toBe(16777216);
    expect(coerceReal(Number.MIN_VALUE)).toBe(0);
    expect(coerceReal(true)).toBe(1);
    expect(coerceLreal(1.337)).toBe(1.337);
    expect(coerceLreal(Number.MAX_VALUE)).toBe(Number.MAX_VALUE);
    expect(coerceLreal(false)).toBe(0);
  });

  it.each([
    [1500.9, 1500],
    [-1500.9, -1500],
    [-0.9, 0],
    [true, 1],
    [false, 0],
  ])("truncates TIME %s to %s milliseconds", (input, expected) => {
    expect(coerceTime(input)).toBe(expected);
  });

  it.each([coerceBool, coerceInt, coerceUint, coerceDint, coerceReal, coerceLreal, coerceTime])(
    "rejects non-finite input in %s",
    (coerce) => {
      for (const value of [NaN, Infinity, -Infinity]) {
        expect(() => coerce(value)).toThrow(RangeError);
      }
      expect(coerce(-0)).toBe(coerce(0));
    },
  );

  it("rejects REAL overflow instead of emitting a non-JSON value", () => {
    expect(() => coerceReal(Number.MAX_VALUE)).toThrow(RangeError);
  });

  it("dispatches by data type with a matching result type", () => {
    const cases: [DataType, number | boolean, number | boolean][] = [
      ["BOOL", 1, true],
      ["INT", 32768, -32768],
      ["UINT", -1, 65535],
      ["DINT", 2147483648, -2147483648],
      ["REAL", 1.337, Math.fround(1.337)],
      ["LREAL", 1.337, 1.337],
      ["TIME", 1.9, 1],
    ];
    for (const [dataType, input, expected] of cases) {
      expect(coerceValue(dataType, input)).toBe(expected);
    }
    expectTypeOf(coerceValue("BOOL", 1)).toEqualTypeOf<boolean>();
    expectTypeOf(coerceValue("INT", true)).toEqualTypeOf<number>();
  });
});

describe("IEC value formatting", () => {
  it.each([
    [0, "T#0ms"],
    [1500, "T#1s500ms"],
    [-1500, "T#-1s500ms"],
    [90061001, "T#1d1h1m1s1ms"],
    [60000, "T#1m"],
    [1.9, "T#1ms"],
    [-0.9, "T#0ms"],
  ])("formats TIME %s as %s", (value, expected) => {
    expect(formatTime(value)).toBe(expected);
    expect(formatValue("TIME", value)).toBe(expected);
  });

  it("formats booleans and wrapped integers", () => {
    expect(formatValue("BOOL", true)).toBe("TRUE");
    expect(formatValue("BOOL", false)).toBe("FALSE");
    expect(formatValue("INT", 32768)).toBe("-32768");
    expect(formatValue("UINT", -1)).toBe("65535");
    expect(formatValue("DINT", 2147483648)).toBe("-2147483648");
  });

  it.each(["REAL", "LREAL"] as const)("always includes a decimal point for %s", (dataType) => {
    expect(formatValue(dataType, 1)).toBe("1.0");
    expect(formatValue(dataType, -0)).toBe("0.0");
    expect(formatValue(dataType, 1.5)).toBe("1.5");
    expect(formatValue(dataType, 1e21)).toMatch(/\.\d+e\+21$/);
    expect(formatValue(dataType, 1e-8)).toMatch(/\.\d+e-\d+$/);
  });
});

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

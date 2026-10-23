import { describe, expect, it } from "vitest";
import type { ScalarValue, StringFunction } from "@benchtop-plc/core";
import { callStandardFunction } from "./standard-functions.js";

const cases: [StringFunction, ScalarValue[], ScalarValue][] = [
  ["LEN", [""], 0],
  ["LEN", ["benchtop"], 8],
  ["LEN", ["😀"], 2],
  ["LEFT", ["", 0], ""],
  ["LEFT", ["ABC", 0], ""],
  ["LEFT", ["ABC", 1], "A"],
  ["LEFT", ["ABC", 5], "ABC"],
  ["RIGHT", ["", 5], ""],
  ["RIGHT", ["ABC", 0], ""],
  ["RIGHT", ["ABC", 2], "BC"],
  ["RIGHT", ["ABC", 5], "ABC"],
  ["MID", ["benchtop", 3, 2], "enc"],
  ["MID", ["ABC", 5, 2], "BC"],
  ["MID", ["ABC", 0, 1], ""],
  ["MID", ["ABC", 2, 3], "C"],
  ["CONCAT", ["", ""], ""],
  ["CONCAT", ["AB", "CD", "E"], "ABCDE"],
  ["INSERT", ["ABC", "X", 0], "XABC"],
  ["INSERT", ["ABC", "X", 2], "ABXC"],
  ["INSERT", ["ABC", "X", 3], "ABCX"],
  ["INSERT", ["", "X", 0], "X"],
  ["INSERT", ["ABC", "", 3], "ABC"],
  ["DELETE", ["ABCDE", 2, 3], "ABE"],
  ["DELETE", ["ABC", 5, 2], "A"],
  ["DELETE", ["ABC", 0, 1], "ABC"],
  ["DELETE", ["ABC", 3, 1], ""],
  ["DELETE", ["ABC", 1, 3], "AB"],
  ["REPLACE", ["ABCDE", "X", 2, 3], "ABXE"],
  ["REPLACE", ["ABC", "X", 5, 2], "AX"],
  ["REPLACE", ["ABC", "X", 0, 1], "XABC"],
  ["REPLACE", ["ABC", "X", 1, 3], "ABX"],
  ["REPLACE", ["ABC", "", 3, 1], ""],
  ["FIND", ["benchtop", "top"], 6],
  ["FIND", ["ABC", "A"], 1],
  ["FIND", ["ABC", "C"], 3],
  ["FIND", ["ABC", "D"], 0],
  ["FIND", ["", ""], 0],
  ["FIND", ["ABC", ""], 0],
  ["FIND", ["ABAB", "AB"], 1],
];

describe.each(["STRING", "WSTRING"] as const)("%s functions", (type) => {
  it.each(cases)("%s(%j) = %j", (name, args, expected) => {
    expect(callStandardFunction(name, args, type)).toBe(expected);
  });
  it.each([
    ["LEFT", ["ABC", -1]],
    ["RIGHT", ["ABC", -1]],
    ["MID", ["ABC", -1, 1]],
    ["MID", ["ABC", 2, 0]],
    ["MID", ["ABC", 2, 4]],
    ["MID", ["", 0, 1]],
    ["INSERT", ["ABC", "X", -1]],
    ["INSERT", ["ABC", "X", 4]],
    ["DELETE", ["ABC", -1, 1]],
    ["DELETE", ["ABC", 1, 0]],
    ["DELETE", ["ABC", 1, 4]],
    ["DELETE", ["", 0, 1]],
    ["REPLACE", ["ABC", "X", -1, 1]],
    ["REPLACE", ["ABC", "X", 1, 0]],
    ["REPLACE", ["ABC", "X", 1, 4]],
    ["REPLACE", ["", "X", 0, 1]],
    ["INSERT", ["ABC", "X", 18446744073709551615n]],
  ] satisfies [StringFunction, ScalarValue[]][])("rejects %s(%s)", (name, args) => {
    expect(() => callStandardFunction(name, args, type)).toThrow(RangeError);
  });
  it.each(["CONCAT", "INSERT", "REPLACE"] as const)(
    "bounds %s results at 1024 code units",
    (name) => {
      const input = "a".repeat(1000),
        extra = "b".repeat(200);
      const args =
        name === "CONCAT"
          ? [input, extra]
          : name === "INSERT"
            ? [input, extra, 1000]
            : [input, extra, 1, 1000];
      const expected =
        name === "REPLACE" ? "a".repeat(999) + "b".repeat(25) : input + "b".repeat(24);
      expect(callStandardFunction(name, args, type)).toBe(expected);
    },
  );
  it("clamps full-width integer lengths before narrowing", () => {
    expect(callStandardFunction("LEFT", ["ABC", 18446744073709551615n], type)).toBe("ABC");
    expect(callStandardFunction("MID", ["ABC", 18446744073709551615n, 2n], type)).toBe("BC");
  });
});

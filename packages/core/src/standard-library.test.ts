import { describe, expect, it } from "vitest";
import {
  getStandardFunctionSignature,
  isFunctionBlockType,
  isStandardFunction,
  standardFunctionBlocks,
  standardFunctions,
} from "./standard-library.js";

describe("shared standard-library descriptors", () => {
  it("preserves the IR's port order and data types", () => {
    const timer = {
      inputs: [
        ["IN", "BOOL"],
        ["PT", "TIME"],
      ],
      outputs: [
        ["Q", "BOOL"],
        ["ET", "TIME"],
      ],
    };
    const trigger = { inputs: [["CLK", "BOOL"]], outputs: [["Q", "BOOL"]] };
    expect(standardFunctionBlocks).toEqual({
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
    });
  });

  it("exposes serializable signatures, including extensible arity and SEL's value ports", () => {
    expect(JSON.parse(JSON.stringify(standardFunctions))).toEqual(standardFunctions);
    expect(getStandardFunctionSignature("MIN")).toMatchObject({ min: 2, max: null });
    expect(getStandardFunctionSignature("REAL_TO_INT")).toEqual({
      min: 1,
      max: 1,
      arguments: [["REAL"]],
      result: "INT",
    });
    expect(getStandardFunctionSignature("SEL").arguments).toEqual([
      ["BOOL"],
      [
        "BOOL",
        "BYTE",
        "WORD",
        "DWORD",
        "SINT",
        "USINT",
        "INT",
        "UINT",
        "DINT",
        "UDINT",
        "REAL",
        "LREAL",
        "TIME",
      ],
    ]);
  });

  it("recognizes canonical names and excludes inherited properties", () => {
    expect(isFunctionBlockType("TON")).toBe(true);
    expect(isStandardFunction("ABS")).toBe(true);
    for (const name of ["ton", "abs", "toString", "constructor", "__proto__", "unknown"]) {
      expect(isFunctionBlockType(name)).toBe(false);
      expect(isStandardFunction(name)).toBe(false);
    }
  });
});

it("registers exactly the current conversion families and no unrelated conversions", () => {
  const numbers = ["SINT", "USINT", "INT", "UINT", "DINT", "UDINT", "REAL", "LREAL"];
  const integers = ["SINT", "USINT", "INT", "UINT", "DINT", "UDINT"];
  const names = numbers.flatMap((from) =>
    numbers.filter((to) => to !== from).map((to) => `${from}_TO_${to}`),
  );
  names.push(
    ...integers.flatMap((type) => [`BOOL_TO_${type}`, `TIME_TO_${type}`, `${type}_TO_TIME`]),
    ...[...numbers, "BOOL", "BYTE", "WORD", "DWORD", "TIME"].map((type) => `TO_${type}`),
    ...["BOOL", "BYTE", "WORD", "DWORD"].flatMap((from) =>
      ["BOOL", "BYTE", "WORD", "DWORD"].filter((to) => to !== from).map((to) => `${from}_TO_${to}`),
    ),
    ...integers.flatMap((type) =>
      ["BYTE", "WORD", "DWORD"].flatMap((bits) => [`${type}_TO_${bits}`, `${bits}_TO_${type}`]),
    ),
    "REAL_TO_DWORD",
    "DWORD_TO_REAL",
  );
  expect(
    Object.keys(standardFunctions)
      .filter((name) => !["ABS", "MIN", "MAX", "LIMIT", "SEL"].includes(name))
      .sort(),
  ).toEqual(names.sort());
});

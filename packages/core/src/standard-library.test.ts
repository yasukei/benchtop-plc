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
      ["BOOL", "INT", "UINT", "DINT", "REAL", "LREAL", "TIME"],
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

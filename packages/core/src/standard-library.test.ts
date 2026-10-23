import { describe, expect, it } from "vitest";
import {
  conversionFunctions,
  truncationFunctions,
  bcdFunctions,
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
    const expected = {
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
    };
    const combined = {
      inputs: [
        ["CU", "BOOL"],
        ["CD", "BOOL"],
        ["R", "BOOL"],
        ["LD", "BOOL"],
        ["PV", "INT"],
      ],
      outputs: [
        ["QU", "BOOL"],
        ["QD", "BOOL"],
        ["CV", "INT"],
      ],
    };
    const typed = Object.fromEntries(
      ["CTU", "CTD", "CTUD"].flatMap((kind) =>
        ["INT", "DINT", "LINT", "UDINT", "ULINT"].map((type) => {
          const descriptor =
            kind === "CTU" ? expected.CTU : kind === "CTD" ? expected.CTD : combined;
          const replaceInt = (ports: string[][]) =>
            ports.map(([name, portType]) => [name, portType === "INT" ? type : portType]);
          return [
            `${kind}_${type}`,
            { inputs: replaceInt(descriptor.inputs), outputs: replaceInt(descriptor.outputs) },
          ];
        }),
      ),
    );
    const longTimer = {
      inputs: [
        ["IN", "BOOL"],
        ["PT", "LTIME"],
      ],
      outputs: [
        ["Q", "BOOL"],
        ["ET", "LTIME"],
      ],
    };
    expect(standardFunctionBlocks).toEqual({
      ...expected,
      CTUD: combined,
      ...typed,
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
      TON_TIME: timer,
      TOF_TIME: timer,
      TP_TIME: timer,
      TON_LTIME: longTimer,
      TOF_LTIME: longTimer,
      TP_LTIME: longTimer,
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
        "LWORD",
        "SINT",
        "USINT",
        "INT",
        "UINT",
        "DINT",
        "UDINT",
        "LINT",
        "ULINT",
        "REAL",
        "LREAL",
        "TIME",
        "LTIME",
        "DATE",
        "TOD",
        "DT",
        "LDATE",
        "LTOD",
        "LDT",
        "STRING",
        "WSTRING",
        "CHAR",
        "WCHAR",
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
  const numbers = [
    "SINT",
    "USINT",
    "INT",
    "UINT",
    "DINT",
    "UDINT",
    "LINT",
    "ULINT",
    "REAL",
    "LREAL",
  ];
  const integers = ["SINT", "USINT", "INT", "UINT", "DINT", "UDINT", "LINT", "ULINT"];
  const names = numbers.flatMap((from) =>
    numbers.filter((to) => to !== from).map((to) => `${from}_TO_${to}`),
  );
  names.push(
    "DATE_TO_LDATE",
    "LDATE_TO_DATE",
    "LDT_TO_LDATE",
    "DT_TO_DATE",
    "DT_TO_TOD",
    "DT_TO_LTOD",
    "DT_TO_LDT",
    "LDT_TO_DT",
    "LDT_TO_DATE",
    "LDT_TO_TOD",
    "LDT_TO_LTOD",
    "TOD_TO_LTOD",
    "LTOD_TO_TOD",
    ...["DATE", "TOD", "DT", "LDATE", "LTOD", "LDT"].map((type) => `TO_${type}`),
    ...integers.flatMap((type) => [
      `BOOL_TO_${type}`,
      `TIME_TO_${type}`,
      `${type}_TO_TIME`,
      `LTIME_TO_${type}`,
      `${type}_TO_LTIME`,
    ]),
    ...[...numbers, "BOOL", "BYTE", "WORD", "DWORD", "LWORD", "TIME", "LTIME"].map(
      (type) => `TO_${type}`,
    ),
    ...["BOOL", "BYTE", "WORD", "DWORD", "LWORD"].flatMap((from) =>
      ["BOOL", "BYTE", "WORD", "DWORD", "LWORD"]
        .filter((to) => to !== from)
        .map((to) => `${from}_TO_${to}`),
    ),
    ...integers.flatMap((type) =>
      ["BYTE", "WORD", "DWORD", "LWORD"].flatMap((bits) => [
        `${type}_TO_${bits}`,
        `${bits}_TO_${type}`,
      ]),
    ),
    "REAL_TO_DWORD",
    "DWORD_TO_REAL",
    "LREAL_TO_LWORD",
    "LWORD_TO_LREAL",
    "TIME_TO_LTIME",
    "LTIME_TO_TIME",
  );
  expect(Object.keys(conversionFunctions).sort()).toEqual(names.sort());
});

it("registers the complete truncation and BCD families", () => {
  const integers = ["SINT", "USINT", "INT", "UINT", "DINT", "UDINT", "LINT", "ULINT"];
  expect(Object.keys(truncationFunctions).sort()).toEqual(
    integers.flatMap((to) => [`TRUNC_${to}`, `REAL_TRUNC_${to}`, `LREAL_TRUNC_${to}`]).sort(),
  );
  expect(Object.keys(bcdFunctions).sort()).toEqual(
    integers
      .flatMap((integer) =>
        ["BYTE", "WORD", "DWORD", "LWORD"].flatMap((bits) => [
          `${bits}_BCD_TO_${integer}`,
          `${integer}_TO_BCD_${bits}`,
        ]),
      )
      .sort(),
  );
  expect(isStandardFunction("TRUNC")).toBe(false);
  expect(getStandardFunctionSignature("EXPT")).toMatchObject({
    arguments: [["REAL", "LREAL"], expect.arrayContaining(["LINT", "ULINT"])],
    resultArgument: 0,
  });
  expect(getStandardFunctionSignature("MUX")).toMatchObject({ genericStart: 1, min: 3, max: null });
  expect(getStandardFunctionSignature("EQ")).toMatchObject({
    genericStart: 0,
    result: "BOOL",
    max: null,
  });
});

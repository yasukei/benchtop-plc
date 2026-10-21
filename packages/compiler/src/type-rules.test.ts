import { expect, it } from "vitest";
import { assignable, binaryType, commonType, scalarTypes, unaryType } from "./type-rules.js";
import type { DataType } from "@benchtop-plc/core";

it("allows precisely identity and the current ADR 0013 widening paths", () => {
  const paths: Record<DataType, string> = {
    DATE: "LDATE",
    TOD: "LTOD",
    DT: "LDT",
    LDATE: "",
    LTOD: "",
    LDT: "",
    BOOL: "BYTE WORD DWORD LWORD",
    BYTE: "WORD DWORD LWORD",
    WORD: "DWORD LWORD",
    DWORD: "LWORD",
    LWORD: "",
    SINT: "INT DINT LINT REAL LREAL",
    USINT: "UINT UDINT ULINT INT DINT LINT REAL LREAL",
    INT: "DINT LINT REAL LREAL",
    UINT: "UDINT ULINT DINT LINT REAL LREAL",
    DINT: "LINT LREAL",
    UDINT: "LINT ULINT LREAL",
    LINT: "",
    ULINT: "",
    REAL: "LREAL",
    LREAL: "",
    TIME: "LTIME",
    LTIME: "",
  };
  for (const from of scalarTypes)
    for (const to of scalarTypes)
      expect(assignable(to, from), `${from} -> ${to}`).toBe(
        from === to || paths[from].split(" ").includes(to),
      );
});
it.each<[DataType[], DataType | null]>([
  [["INT", "UINT"], "DINT"],
  [["SINT", "USINT"], "INT"],
  [["DINT", "UDINT"], "LINT"],
  [["LINT", "ULINT"], null],
  [["LINT", "LREAL"], null],
  [["TIME", "LTIME"], "LTIME"],
  [["BOOL", "BYTE"], "BYTE"],
  [["UDINT", "REAL"], "LREAL"],
  [["DINT", "REAL"], "LREAL"],
  [["REAL", "LREAL"], "LREAL"],
  [["INT", "UINT", "REAL"], "REAL"],
  [["UINT", "UINT"], "UINT"],
  [["TIME", "INT"], null],
  [["BOOL", "INT"], null],
  [["BOOL", "BOOL"], "BOOL"],
])("finds a set-based common type for %j", (types, expected) => {
  for (const order of [types, [...types].reverse(), [...types.slice(1), types[0]!]])
    expect(commonType(order)).toBe(expected);
});
it("accepts BOOL ordering and signed TIME, and rejects unsigned negation", () => {
  expect(binaryType("<", "BOOL", "BOOL")).toBe("BOOL");
  expect(unaryType("-", "TIME")).toBe("TIME");
  expect(unaryType("-", "UINT")).toBeNull();
});

import { expect, it } from "vitest";
import { assignable, binaryType, commonType, scalarTypes, unaryType } from "./type-rules.js";
import type { DataType } from "@benchtop-plc/core";

it("allows precisely identity and the current ADR 0013 widening paths", () => {
  const paths: Record<DataType, string> = {
    BOOL: "BYTE WORD DWORD",
    BYTE: "WORD DWORD",
    WORD: "DWORD",
    DWORD: "",
    SINT: "INT DINT REAL LREAL",
    USINT: "UINT UDINT INT DINT REAL LREAL",
    INT: "DINT REAL LREAL",
    UINT: "UDINT DINT REAL LREAL",
    DINT: "LREAL",
    UDINT: "LREAL",
    REAL: "LREAL",
    LREAL: "",
    TIME: "",
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
  [["DINT", "UDINT"], null],
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

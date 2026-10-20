import { expect, it } from "vitest";
import { assignable, binaryType, commonType, scalarTypes, unaryType } from "./type-rules.js";
import type { DataType } from "@benchtop-plc/core";

it("allows precisely identity and the current ADR 0013 widening paths", () => {
  const paths = [
    "INT:DINT",
    "UINT:DINT",
    "INT:REAL",
    "UINT:REAL",
    "INT:LREAL",
    "UINT:LREAL",
    "DINT:LREAL",
    "REAL:LREAL",
  ];
  for (const from of scalarTypes)
    for (const to of scalarTypes)
      expect(assignable(to, from), `${from} -> ${to}`).toBe(
        from === to || paths.includes(`${from}:${to}`),
      );
});
it.each<[DataType[], DataType | null]>([
  [["INT", "UINT"], "DINT"],
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

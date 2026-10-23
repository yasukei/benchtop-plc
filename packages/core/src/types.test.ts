import { expect, it } from "vitest";
import {
  formatType,
  sameScalarType,
  scalarBase,
  validateScalar,
  type TypeDescriptor,
  type TypeTable,
} from "./index.js";

const table: TypeTable = [
  {
    name: "Color",
    definition: { kind: "enumeration", base: "INT", values: [{ name: "Red", value: 0 }] },
    initialValue: 0,
  },
  {
    name: "Other",
    definition: { kind: "enumeration", base: "INT", values: [{ name: "Red", value: 0 }] },
    initialValue: 0,
  },
  {
    name: "Hue",
    definition: { kind: "alias", type: { kind: "named", name: "Color" } },
    initialValue: 0,
  },
  {
    name: "Percent",
    definition: { kind: "subrange", base: "INT", lower: 0, upper: 100 },
    initialValue: 0,
  },
];
const named = (name: string): TypeDescriptor => ({ kind: "named", name });
it("uses enum name equivalence through aliases and subrange structural equivalence", () => {
  expect(sameScalarType(named("Color"), named("Other"), table)).toBe(false);
  expect(sameScalarType(named("Color"), named("hue"), table)).toBe(true);
  expect(sameScalarType(named("Percent"), "INT", table)).toBe(false);
  expect(
    sameScalarType(
      named("Percent"),
      { kind: "subrange", base: "INT", lower: 0, upper: 100 },
      table,
    ),
  ).toBe(true);
  expect(scalarBase(named("Hue"), table)).toBe("INT");
});
it("checks both base representation and derived limits without coercion", () => {
  for (const value of [1, 0.5, "0"])
    expect(() => validateScalar(named("Color"), value, table)).toThrow(RangeError);
  expect(() => validateScalar(named("Color"), 0, table)).not.toThrow();
  expect(() => validateScalar(named("Percent"), 101, table)).toThrow(RangeError);
  expect(() => validateScalar(named("Percent"), 100, table)).not.toThrow();
});
it("rejects unknown and cyclic aliases instead of looping", () => {
  expect(() => scalarBase(named("Missing"), table)).toThrow(RangeError);
  expect(() =>
    scalarBase(named("Loop"), [
      { name: "Loop", definition: { kind: "alias", type: named("Loop") }, initialValue: 0 },
    ]),
  ).toThrow(RangeError);
});
it.each([
  ["INT", "INT"],
  [named("Color"), "Color"],
  [
    { kind: "subrange", base: "LINT", lower: "-9007199254740993", upper: "9007199254740993" },
    "LINT (-9007199254740993..9007199254740993)",
  ],
  [
    { kind: "array", dimensions: [{ lower: 1, upper: 10 }, "*"], element: "INT" },
    "ARRAY[1..10, *] OF INT",
  ],
  [{ kind: "reference", target: named("Color") }, "REF_TO Color"],
  [{ kind: "string", base: "STRING", length: 20 }, "STRING[20]"],
  [{ kind: "character", base: "WCHAR" }, "WCHAR"],
] satisfies [TypeDescriptor, string][])("prints source-like descriptor %j", (type, expected) => {
  expect(formatType(type)).toBe(expected);
});

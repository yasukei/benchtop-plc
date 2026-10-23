import { expect, it } from "vitest";
import {
  characterTypes,
  formatValue,
  readStringLiteral,
  validateValue,
  validateScalar,
  sameScalarType,
  scalarBase,
  coerceValue,
  binaryValue,
  internalValue,
} from "./index.js";

it.each(characterTypes)("round-trips quoted %s values including every code unit", (type) => {
  const character = type === "CHAR" || type === "WCHAR";
  const limit = type === "STRING" || type === "CHAR" ? 256 : 65536;
  // Include every UTF-16 unit, including isolated surrogates, in bounded chunks.
  for (let start = 0; start < limit; start += character ? 1 : 1024) {
    const value = String.fromCharCode(
      ...Array.from(
        { length: Math.min(character ? 1 : 1024, limit - start) },
        (_, index) => start + index,
      ),
    );
    validateValue(type, value);
    expect(readStringLiteral(formatValue(type, value)).value).toBe(value);
  }
});

it("uses type discriminators for text and decimal strings", () => {
  expect(coerceValue("STRING", "123")).toBe("123");
  expect(internalValue("STRING", "123")).toBe("123");
  expect(internalValue("LINT", "123")).toBe(123n);
  expect(binaryValue("<", "10", "2")).toBe(true);
  expect(binaryValue("<", 10n, 2n)).toBe(false);
  expect(formatValue("STRING", "123")).toBe("'123'");
  expect(formatValue("LINT", "123")).toBe("123");
});

it("validates base representations and capacities while ignoring lengths for type identity", () => {
  const short = { kind: "string", base: "STRING", length: 2 } as const;
  expect(scalarBase(short)).toBe("STRING");
  expect(sameScalarType(short, { ...short, length: 20 })).toBe(true);
  expect(sameScalarType(short, "STRING")).toBe(true);
  expect(sameScalarType(short, "WSTRING")).toBe(false);
  expect(() => validateScalar(short, "abc")).toThrow(RangeError);
  expect(() => validateValue("CHAR", "ab")).toThrow(RangeError);
  expect(() => validateValue("STRING", "Ā")).toThrow(RangeError);
  expect(() => validateValue("WCHAR", "😀")).toThrow(RangeError);
  expect(() => validateValue("WCHAR", "\ud800")).not.toThrow();
});

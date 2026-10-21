import { expect, it } from "vitest";
import { coerceLong, coerceValue, formatValue, parseLong, validateValue } from "./values.js";

it.each(["LINT", "ULINT", "LWORD", "LTIME"] as const)(
  "validates %s canonical strings before parsing",
  (type) => {
    expect(parseLong(type, "0")).toBe(0n);
    expect(parseLong(type, "9007199254740993")).toBe(9007199254740993n);
    for (const value of [
      " 12",
      "0x10",
      "+1",
      "-0",
      "00",
      "01",
      "1\n",
      "1.0",
      "1e1",
      1,
      1n,
      "9".repeat(100),
    ])
      expect(() => validateValue(type, value)).toThrow(RangeError);
  },
);
it("wraps long computations and narrows without rounding their low bits", () => {
  expect(coerceLong("LINT", 9223372036854775808n)).toBe("-9223372036854775808");
  expect(coerceLong("ULINT", -1n)).toBe("18446744073709551615");
  expect(coerceLong("LWORD", 1n << 64n)).toBe("0");
  expect(coerceLong("LTIME", -(1n << 63n) - 1n)).toBe("9223372036854775807");
  expect(coerceValue("DINT", "9223372036854775807")).toBe(-1);
  expect(coerceValue("WORD", 0xfedcba9876543210n)).toBe(0x3210);
  expect(coerceValue("BOOL", 2n)).toBe(true);
});
it("formats signed minimum durations and unsigned maximum bit patterns", () => {
  expect(formatValue("LTIME", "-9223372036854775808")).toBe(
    "LTIME#-106751d23h47m16s854ms775us808ns",
  );
  expect(formatValue("LTIME", "0")).toBe("LTIME#0s");
  expect(formatValue("LWORD", "18446744073709551615")).toBe("16#FFFFFFFFFFFFFFFF");
});

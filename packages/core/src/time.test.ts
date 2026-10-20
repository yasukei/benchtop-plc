import { expect, it } from "vitest";
import { coerceTime, formatTime, timeBinary, validateTime } from "./index.js";

it("wraps TIME results and formats both boundaries", () => {
  expect(coerceTime(2147483648)).toBe(-2147483648);
  expect(coerceTime(-2147483649)).toBe(2147483647);
  expect(formatTime(2147483647)).toBe("T#24d20h31m23s647ms");
  expect(formatTime(-2147483648)).toBe("T#-24d20h31m23s648ms");
});

it.each([NaN, Infinity, -Infinity, -0, 0.5, 2147483648, -2147483649])(
  "rejects external TIME %s without wrapping",
  (value) => {
    expect(() => validateTime(value)).toThrow(RangeError);
  },
);
it.each([-2147483648, 0, 2147483647])("accepts external TIME %s", (value) => {
  expect(() => validateTime(value)).not.toThrow();
});

it.each([
  ["*", 3, 0.5, 2],
  ["*", 5, 0.5, 2],
  ["*", -3, 0.5, -2],
  ["*", -5, 0.5, -2],
  ["/", 5, 2, 2],
  ["/", 7, 2, 4],
  ["/", -7, 2, -4],
  ["*", 2147483647, 1.5, -1073741826],
  // Binary64 multiplication alone rounds this exact integer product incorrectly.
  ["*", 2147483647, 1000000001, 1147483647],
  ["*", 1000, 1e100, 0],
  ["*", 1000, Number.MAX_VALUE, 0],
  ["/", 1, Number.MIN_VALUE, 0],
  ["*", 1, Number.MIN_VALUE, 0],
  ["/", 1, Number.MAX_VALUE, 0],
] as const)("computes TIME %s %s %s exactly", (operator, left, right, expected) => {
  expect(timeBinary(operator, left, right, "LREAL")).toBe(expected);
});
it("truncates integer division and faults on invalid scaling operands", () => {
  expect(timeBinary("/", -7, 2, "DINT")).toBe(-3);
  for (const value of [NaN, Infinity, -Infinity])
    expect(() => timeBinary("*", 1, value, "LREAL")).toThrow(RangeError);
  expect(() => timeBinary("/", 1, 0, "INT")).toThrow(RangeError);
});

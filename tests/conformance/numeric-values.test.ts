import { coerceValue } from "@benchtop-plc/core";
import { expect, it } from "vitest";

// Compiler/runtime conformance will reuse these assignment coercions once those packages land.
it("defines the milestone's integer assignment wrap-around semantics", () => {
  expect(coerceValue("INT", 32767 + 1)).toBe(-32768);
  expect(coerceValue("INT", -32768 - 1)).toBe(32767);
  expect(coerceValue("UINT", 65535 + 1)).toBe(0);
  expect(coerceValue("UINT", 0 - 1)).toBe(65535);
  expect(coerceValue("DINT", 2147483647 + 1)).toBe(-2147483648);
  expect(coerceValue("DINT", -2147483648 - 1)).toBe(2147483647);
});

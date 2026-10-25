import { expect, it } from "vitest";
import {
  parseDirectAddress,
  readDirectValue,
  writeDirectValue,
  directBits,
  validDirectAddress,
} from "./direct-address.js";
import type { TypedValue } from "./values.js";

it.each([
  ["%IB0", { dataType: "SINT", value: -5 }, [251]],
  ["%IW1", { dataType: "INT", value: -5 }, [251, 255]],
  ["%ID1", { dataType: "DWORD", value: 0x01020304 }, [4, 3, 2, 1]],
  ["%ID0", { dataType: "REAL", value: 1.5 }, [0, 0, 192, 63]],
  ["%IL0", { dataType: "LREAL", value: 1.5 }, [0, 0, 0, 0, 0, 0, 248, 63]],
  ["%IL1", { dataType: "LINT", value: "-1" }, Array<number>(8).fill(255)],
  ["%IL1", { dataType: "ULINT", value: "18446744073709551615" }, Array<number>(8).fill(255)],
] as const)("encodes and decodes little-endian %s", (text, value, expected) => {
  const address = parseDirectAddress(text)!;
  const image = Array<number>(64).fill(0);
  writeDirectValue(image, address, value as TypedValue);
  const offset = address.size === "X" ? address.byte : address.index * expected.length;
  expect(image.slice(offset, offset + expected.length)).toEqual(expected);
  expect(readDirectValue(image, address, value.dataType)).toEqual(value.value);
});
it("preserves adjacent bits and accepts raw non-finite patterns", () => {
  const bytes = Array<number>(64).fill(0);
  writeDirectValue(bytes, parseDirectAddress("%IB1")!, { dataType: "BYTE", value: 0xaa });
  writeDirectValue(bytes, parseDirectAddress("%IX1.0")!, { dataType: "BOOL", value: true });
  expect(bytes[1]).toBe(0xab);
  writeDirectValue(bytes, parseDirectAddress("%ID0")!, { dataType: "DWORD", value: 0x7fc00000 });
  expect(readDirectValue(bytes, parseDirectAddress("%ID0")!, "REAL")).toBeNaN();
  expect(directBits(bytes, parseDirectAddress("%ID0")!)).toBe("16#7FC00000");
});
it("validates bounds and rejects malformed, incompatible and invalid writes atomically", () => {
  expect(parseDirectAddress("%IX1.2.3")).toBeNull();
  expect(validDirectAddress(parseDirectAddress("%IW32")!)).toBe(false);
  const bytes = Array<number>(64).fill(0);
  for (const value of [
    { dataType: "INT", value: 40000 },
    { dataType: "BOOL", value: true },
  ] as TypedValue[])
    expect(() => writeDirectValue(bytes, parseDirectAddress("%IW0")!, value)).toThrow(RangeError);
  expect(bytes.every((b) => b === 0)).toBe(true);
});

it("normalizes IEEE negative zero while retaining raw area bytes", () => {
  const bytes = Array<number>(64).fill(0);
  writeDirectValue(bytes, parseDirectAddress("%ID0")!, { dataType: "DWORD", value: 0x80000000 });
  expect(Object.is(readDirectValue(bytes, parseDirectAddress("%ID0")!, "REAL"), 0)).toBe(true);
  expect(directBits(bytes, parseDirectAddress("%ID0")!)).toBe("16#80000000");
  expect(validDirectAddress({ area: "I", size: "D", index: 0.25 })).toBe(false);
});

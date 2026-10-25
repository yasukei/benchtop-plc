import { describe, expect, it } from "vitest";
import { addressTypes } from "@benchtop-plc/core";
import { addPart, assignAddress, panelAddresses, partSize, readLayout } from "./layout.js";
import { assignNumericBounds, assignNumericType, parseNumericInput } from "./numeric.js";

const input = () => addPart([], "numericInput", "Setpoint")[0]!;
describe("numeric panel bindings", () => {
  for (const size of ["B", "W", "D", "L"] as const) {
    for (const dataType of addressTypes[size]) {
      it(`binds ${dataType} to ${size} input and output addresses`, () => {
        for (const kind of ["numericInput", "numericDisplay"] as const) {
          const part = assignNumericType(addPart([], kind, "Value")[0]!, dataType);
          const area = kind === "numericInput" ? "I" : "Q";
          expect(part).toMatchObject({ dataType, address: `%${area}${size}0` });
          expect(readLayout([part])).toEqual([part]);
          expect(panelAddresses(part)).toContain(part.address);
          expect(assignAddress(part, panelAddresses(part).at(-1)!)).toBeDefined();
          for (const address of [
            `%${area}X0.0`,
            `%M${size}0`,
            `%${area === "I" ? "Q" : "I"}${size}0`,
            `%${area}${size}64`,
            "bad",
          ])
            expect(() => assignAddress(part, address)).toThrow();
        }
      });
    }
  }
  it("rejects mismatched sizes and malformed imported numeric settings", () => {
    for (const fields of [
      { address: "%IB0" },
      { dataType: "BOOL" },
      { dataType: "TIME" },
      { dataType: undefined },
      { min: NaN },
      { max: Infinity },
      { min: "0" },
      { min: -32769 },
      { min: 5, max: 5 },
      { min: 10, max: 0 },
    ])
      expect(readLayout([{ ...input(), ...fields }])).toBeNull();
    expect(
      readLayout([
        { id: "1", kind: "numericDisplay", address: "%QD0", dataType: "REAL", x: 0, y: 0 },
      ])?.[0],
    ).toMatchObject({ label: "", dataType: "REAL" });
    expect(readLayout([{ ...addPart([], "numericDisplay", "Value")[0], min: 0 }])).toBeNull();
  });
  it.each([
    ["numericInput", "pushbutton", "I"],
    ["numericInput", "selector", "I"],
    ["numericDisplay", "led", "Q"],
  ] as const)("allocates disjoint defaults for %s and %s in either order", (numeric, bit, area) => {
    let layout = addPart([], numeric, "First");
    layout = addPart(layout, numeric, "Second");
    layout = addPart(layout, bit, "Bit");
    expect(layout.map((part) => part.address)).toEqual([
      `%${area}W0`,
      `%${area}W1`,
      `%${area}X4.0`,
    ]);

    layout = addPart([], bit, "First bit");
    layout = addPart(layout, numeric, "Number");
    layout = addPart(layout, bit, "Second bit");
    expect(layout.map((part) => part.address)).toEqual([
      `%${area}X0.0`,
      `%${area}W1`,
      `%${area}X0.1`,
    ]);
  });
  it.each([
    ["USINT", "%IB1", "%IW1", "%IX0.0"],
    ["DINT", "%ID0", "%IW2", "%IX4.0"],
    ["ULINT", "%IL0", "%IW4", "%IX8.0"],
  ] as const)("accounts for the byte range of existing %s parts", (type, address, word, bit) => {
    const existing = assignAddress(assignNumericType(input(), type), address);
    expect(addPart([existing], "numericInput", "Number")[1]?.address).toBe(word);
    expect(addPart([existing], "pushbutton", "Bit")[1]?.address).toBe(bit);
  });
  it("keeps input and output areas separate and reuses addresses after deletion", () => {
    const existing = input();
    expect(addPart([existing], "numericDisplay", "Output")[1]?.address).toBe("%QW0");
    expect(addPart([existing], "led", "Lamp")[1]?.address).toBe("%QX0.0");
    const second = addPart([existing], "numericInput", "Second")[1]!;
    expect(addPart([second], "numericInput", "Reused")[1]?.address).toBe("%IW0");
    expect(assignAddress(second, "%IW0").address).toBe("%IW0");
  });
  it("falls back to the first address only after all candidates are occupied", () => {
    const full = Array.from({ length: 8 }, (_, index) => ({
      ...assignNumericType(input(), "ULINT"),
      id: String(index),
      address: `%IL${index}`,
    }));
    expect(addPart(full, "numericInput", "Number").at(-1)?.address).toBe("%IW0");
    expect(addPart(full, "pushbutton", "Bit").at(-1)?.address).toBe("%IX0.0");
  });
  it("spaces wider numeric parts apart from bit controls", () => {
    let layout = addPart([], "led", "Lamp");
    layout = addPart(layout, "numericInput", "Setpoint");
    layout = addPart(layout, "numericDisplay", "Actual");
    for (const [i, part] of layout.entries())
      for (const other of layout.slice(i + 1))
        expect(
          Math.abs(part.x - other.x) * 300 >= (partSize(part).width + partSize(other).width) / 2 ||
            Math.abs(part.y - other.y) * 190 >= 84,
        ).toBe(true);
  });
  it("changes size at the end of the area and drops bounds incompatible with a new type", () => {
    const part = assignAddress(input(), "%IW31");
    expect(assignNumericType(part, "LREAL").address).toBe("%IL7");
    expect(assignNumericType(assignNumericBounds(part, "-10", "10"), "UINT")).not.toHaveProperty(
      "min",
    );
  });
});

describe("numeric input validation", () => {
  it.each([
    ["SINT", "-128", -128, "-129"],
    ["USINT", "255", 255, "256"],
    ["INT", "-32768", -32768, "32768"],
    ["UINT", "65535", 65535, "-1"],
    ["DINT", "2147483647", 2147483647, "2147483648"],
    ["UDINT", "4294967295", 4294967295, "4294967296"],
    ["BYTE", "255", 255, "256"],
    ["WORD", "65535", 65535, "65536"],
    ["DWORD", "4294967295", 4294967295, "-1"],
    ["LINT", "-9223372036854775808", "-9223372036854775808", "9223372036854775808"],
    ["ULINT", "18446744073709551615", "18446744073709551615", "18446744073709551616"],
    ["LWORD", "18446744073709551615", "18446744073709551615", "-1"],
    ["REAL", "0.1", Math.fround(0.1), "3.5e38"],
    ["LREAL", "1e300", 1e300, "1e309"],
  ] as const)(
    "validates %s without wrapping or losing digits",
    (type, valid, expected, invalid) => {
      const part = assignNumericType(input(), type);
      expect(parseNumericInput(part, valid)).toEqual({ dataType: type, value: expected });
      expect(parseNumericInput(part, invalid)).toBeNull();
    },
  );
  it("rejects fractional integers, non-finite values and empty fields", () => {
    for (const text of ["", "NaN", "Infinity", "1.1", "32767.000000000001", "1; x := 2", "16#FFFF"])
      expect(parseNumericInput(input(), text)).toBeNull();
  });
  it("validates optional bounds and enforces them on input", () => {
    const part = assignNumericBounds(input(), "-5", "100");
    expect(parseNumericInput(part, "-5")?.value).toBe(-5);
    expect(parseNumericInput(part, "100")?.value).toBe(100);
    expect(parseNumericInput(part, "101")).toBeNull();
    expect(parseNumericInput(part, "-6")).toBeNull();
    expect(assignNumericBounds(part, "", "")).not.toHaveProperty("min");
    for (const [min, max] of [
      ["10", "1"],
      ["0", "999999"],
      ["NaN", "10"],
    ])
      expect(() => assignNumericBounds(part, min!, max!)).toThrow();
  });
});

it("compares real bounds at storage precision and rejects rounded integer bound text", () => {
  const real = assignNumericBounds(assignNumericType(input(), "REAL"), "0.1", "0.2");
  expect(parseNumericInput(real, "0.1")?.value).toBe(Math.fround(0.1));
  expect(parseNumericInput(real, "0.2")?.value).toBe(Math.fround(0.2));
  expect(parseNumericInput(real, "0.21")).toBeNull();
  expect(() => assignNumericBounds(input(), "0", "32767.0000000000001")).toThrow();
  expect(() =>
    assignNumericBounds(assignNumericType(input(), "LINT"), "0", "9007199254740993"),
  ).toThrow();
});

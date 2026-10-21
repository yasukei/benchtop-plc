import { describe, expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import { parseWrittenValue, variableValue } from "./monitor.js";

describe("monitor values", () => {
  it("accepts finite typed values and TIME literals or milliseconds", () => {
    expect(parseWrittenValue("BOOL", "false")).toEqual({ dataType: "BOOL", value: false });
    expect(parseWrittenValue("INT", "-123")).toEqual({ dataType: "INT", value: -123 });
    expect(parseWrittenValue("REAL", "1.25")).toEqual({ dataType: "REAL", value: 1.25 });
    expect(parseWrittenValue("TIME", "T#1s500ms")).toEqual({ dataType: "TIME", value: 1500 });
    expect(parseWrittenValue("TIME", "1500")).toEqual({ dataType: "TIME", value: 1500 });
    expect(parseWrittenValue("TIME", "T#-1s")).toEqual({ dataType: "TIME", value: -1000 });
  });
  it("rejects invalid literals, nonfinite values and out-of-range integers", () => {
    for (const input of ["", " ", "NaN", "Infinity", "1e999", "1; x := 2"])
      expect(parseWrittenValue("LREAL", input)).toBeNull();
    expect(parseWrittenValue("BOOL", "1")).toBeNull();
    expect(parseWrittenValue("INT", "32768")).toBeNull();
    expect(parseWrittenValue("UINT", "-1")).toBeNull();
    expect(parseWrittenValue("DINT", "2147483648")).toBeNull();
    expect(parseWrittenValue("TIME", "T#garbage")).toBeNull();
    expect(parseWrittenValue("TIME", `T#${"9".repeat(309)}ms`)).toBeNull();
    expect(parseWrittenValue("TIME", "T#1s T#2s")).toBeNull();
    expect(parseWrittenValue("TIME", "1.5")).toBeNull();
    for (const text of [
      "2147483648",
      "-2147483649",
      "T#30d",
      "T#-25d",
      "T#2147483647.0000000001ms",
    ])
      expect(parseWrittenValue("TIME", text)).toBeNull();
    expect(parseWrittenValue("TIME", "2147483647")?.value).toBe(2147483647);
    expect(parseWrittenValue("TIME", "-2147483648")?.value).toBe(-2147483648);
    expect(parseWrittenValue("REAL", "1e100")).toBeNull();
  });
  it("shows FB outputs with descriptor names and IEC formatting", () => {
    const variable = compile("PROGRAM Main VAR timer: TON; END_VAR END_PROGRAM").ir!.variables[0]!;
    expect(
      variableValue(variable, {
        kind: "functionBlock",
        inputs: [],
        outputs: [
          { dataType: "BOOL", value: true },
          { dataType: "TIME", value: 1250 },
        ],
      }),
    ).toBe("Q=TRUE, ET=T#1s250ms");
    expect(variableValue(variable, undefined)).toBe("—");
  });
});

it.each([
  ["SINT", "-128", -128],
  ["USINT", "255", 255],
  ["UDINT", "4294967295", 4294967295],
  ["BYTE", "16#ff", 255],
  ["WORD", "16#00_FF", 255],
  ["WORD", "2#1000_0000_0000_0000", 32768],
  ["DWORD", "16#FFFF_FFFF", 4294967295],
  ["WORD", "65535", 65535],
  ["USINT", "2.55e2", 255],
  ["UDINT", "42949672950e-1", 4294967295],
] as const)("parses monitor input %s %s", (type, text, value) => {
  expect(parseWrittenValue(type, text)).toEqual({ dataType: type, value });
});
it.each([
  ["SINT", "128"],
  ["SINT", "-129"],
  ["USINT", "256"],
  ["USINT", "-1"],
  ["UDINT", "4294967296"],
  ["BYTE", "16#100"],
  ["WORD", "65536"],
  ["DWORD", "16#100000000"],
  ["DWORD", "-1"],
  ["WORD", "2#102"],
  ["WORD", "1.5"],
  ["WORD", "16#FF; x := 1"],
  ["WORD", "16#__FF"],
  ["INT", "32767.00000000000000001"],
  ["UDINT", "4294967295.00000000001"],
  ["BYTE", "255.00000000000000001"],
  ["UINT", "-0.00000000000000000001"],
  ["WORD", "1e-99999999999999999999"],
] as const)("rejects monitor input %s %s", (type, text) => {
  expect(parseWrittenValue(type, text)).toBeNull();
});

it.each([
  ["LINT", "9223372036854775807", "9223372036854775807"],
  ["LINT", "-9223372036854775808", "-9223372036854775808"],
  ["ULINT", "18446744073709551615", "18446744073709551615"],
  ["LWORD", "16#FFFF_FFFF_FFFF_FFFF", "18446744073709551615"],
  [
    "LWORD",
    "2#1000000000000000000000000000000000000000000000000000000000000001",
    "9223372036854775809",
  ],
  ["LTIME", "LTIME#1ms500us7ns", "1500007"],
  ["LTIME", "-9007199254740993", "-9007199254740993"],
] as const)("parses %s monitor input %s without precision loss", (type, input, expected) => {
  expect(parseWrittenValue(type, input)).toEqual({ dataType: type, value: expected });
});
it.each([
  ["LINT", "9223372036854775808"],
  ["LINT", "1.5"],
  ["LINT", "0x10"],
  ["ULINT", "-1"],
  ["LWORD", "16#10000000000000000"],
  ["LTIME", "LT#9223372036854775808ns"],
  ["LTIME", "LT#0.1ns"],
  ["LINT", "1; END_VAR x := 1"],
] as const)("rejects invalid %s monitor input %s", (type, input) => {
  expect(parseWrittenValue(type, input)).toBeNull();
});

it.each([
  ["DATE", "D#2024-02-29", 1709164800],
  ["TOD", "TOD#12:30:15.5", 45015500],
  ["DT", "DT#1970-01-01-00:00:01", 1],
  ["LDATE", "LDATE#1969-12-31", "-86400000000000"],
  ["LTOD", "LTOD#00:00:00.000000001", "1"],
  ["LDT", "LDT#1969-12-31-23:59:59.999999999", "-1"],
] as const)("parses calendar monitor input for %s", (dataType, text, value) => {
  expect(parseWrittenValue(dataType, text)).toEqual({ dataType, value });
});
it.each([
  ["DATE", "D#2023-02-29"],
  ["DATE", "1"],
  ["DATE", "D#2024-02-29; END_VAR"],
  ["TOD", "TOD#24:00:00"],
  ["TOD", "86400000"],
  ["DT", "DT#2106-02-07-06:28:16"],
  ["LDATE", "1"],
  ["LTOD", "LTOD#24:00:00"],
  ["LDT", "LDT#2262-04-11-23:47:16.854775808"],
] as const)("rejects invalid calendar monitor input for %s", (type, text) => {
  expect(parseWrittenValue(type, text)).toBeNull();
});

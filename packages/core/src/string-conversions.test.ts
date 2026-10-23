import { describe, expect, it } from "vitest";
import { convertValue } from "./conversions.js";
import { formatValue, type DataType, type ScalarValue } from "./values.js";
import type { ConversionFunction } from "./ir.js";

const samples: [DataType, number | string | boolean][] = [
  ["BOOL", true],
  ["BOOL", false],
  ["SINT", -128],
  ["USINT", 255],
  ["INT", -42],
  ["UINT", 65535],
  ["DINT", -2147483648],
  ["UDINT", 4294967295],
  ["LINT", "-9223372036854775808"],
  ["LINT", "9223372036854775807"],
  ["ULINT", "18446744073709551615"],
  ["BYTE", 255],
  ["WORD", 65535],
  ["DWORD", 4294967295],
  ["LWORD", "18446744073709551615"],
  ["REAL", Math.fround(0.1)],
  ["REAL", Math.fround(3.4028234663852886e38)],
  ["REAL", 2 ** -149],
  ["LREAL", Number.MAX_VALUE],
  ["LREAL", Number.MIN_VALUE],
  ["LREAL", -1.0000000000000002],
  ["TIME", 1500],
  ["TIME", -2147483648],
  ["TIME", 2147483647],
  ["LTIME", "-9223372036854775808"],
  ["LTIME", "9223372036854775807"],
  ["DATE", 0],
  ["DATE", 86400],
  ["TOD", 86399999],
  ["DT", 4294967295],
  ["LDATE", "-86400000000000"],
  ["LTOD", "86399999999999"],
  ["LDT", "-9223372036854775808"],
  ["LDT", "9223372036854775807"],
];

describe.each(["STRING", "WSTRING"] as const)("%s conversions", (textType) => {
  it.each(samples)("round trips %s %s using the monitor format", (type, value) => {
    const encoded = convertValue(`${type}_TO_${textType}` as ConversionFunction, value);
    expect(encoded).toBe(formatValue(type, value));
    expect(convertValue(`${textType}_TO_${type}` as ConversionFunction, encoded)).toBe(value);
    expect(convertValue(`TO_${textType}`, value, type)).toBe(encoded);
    expect(convertValue(`TO_${type}`, encoded, textType)).toBe(value);
  });
  it.each([
    ["INT", " INT#-42 ", -42],
    ["INT", "123", 123],
    ["INT", "+1_234", 1234],
    ["INT", "-16#2A", -42],
    ["BOOL", "BOOL#TRUE", true],
    ["BOOL", "2#1", true],
    ["BYTE", "BYTE#16#FF", 255],
    ["LWORD", "LWORD#2#1111", "15"],
    ["REAL", "REAL#0.1", Math.fround(0.1)],
    ["LREAL", "LREAL#16#FF", 255],
    ["TIME", "time#1s500ms", 1500],
    ["TIME", "t#1s500ms", 1500],
    ["TIME", "1s500ms", 1500],
    ["TIME", "+1.5ms", 1],
    ["TIME", "1h_30m", 5400000],
    ["LTIME", "LTIME#1ns", "1"],
    ["LTIME", "LT#1ns", "1"],
    ["DATE", "DATE#1970-01-02", 86400],
    ["DATE", "D#1970-01-02", 86400],
    ["LDATE", "LDATE#1970-01-02", "86400000000000"],
    ["LDATE", "LD#1970-01-02", "86400000000000"],
    ["TOD", "TIME_OF_DAY#00:00:00.001", 1],
    ["TOD", "TOD#00:00:00.001", 1],
    ["LTOD", "LTIME_OF_DAY#00:00:00.000000001", "1"],
    ["LTOD", "LTOD#00:00:00.000000001", "1"],
    ["DT", "DATE_AND_TIME#1970-01-01-00:00:01", 1],
    ["DT", "DT#1970-01-01-00:00:01", 1],
    ["LDT", "LDATE_AND_TIME#1970-01-01-00:00:00.000000001", "1"],
    ["LDT", "LDT#1970-01-01-00:00:00.000000001", "1"],
  ] satisfies [DataType, string, ScalarValue][])("parses %s from %s", (type, text, value) => {
    expect(convertValue(`${textType}_TO_${type}` as ConversionFunction, text)).toBe(value);
  });
  it.each([
    ["INT", ""],
    ["INT", "123tail"],
    ["INT", "32768"],
    ["INT", "-32769"],
    ["INT", "DINT#1"],
    ["INT", "1.0"],
    ["INT", "1e0"],
    ["INT", "1__0"],
    ["INT", "2#102"],
    ["INT", "16#F_"],
    ["INT", "0x10"],
    ["BOOL", "2"],
    ["BOOL", "true false"],
    ["USINT", "-1"],
    ["ULINT", "18446744073709551616"],
    ["LINT", "-9223372036854775809"],
    ["REAL", "1e39"],
    ["LREAL", "Infinity"],
    ["LREAL", "NaN"],
    ["LREAL", "1e10001"],
    ["TIME", "2147483648ms"],
    ["TIME", "T#1ns"],
    ["TIME", "1s2s"],
    ["TIME", "1ms1s"],
    ["TIME", "1.5s2ms"],
    ["TIME", "1s_"],
    ["TIME", "1s garbage"],
    ["TIME", "1_"],
    ["LTIME", "0.1ns"],
    ["LTIME", "9223372036854775808ns"],
    ["DATE", "2024-02-30"],
    ["DATE", "TOD#00:00:00"],
    ["DATE", "2024-01-01#1970-01-01"],
    ["TOD", "24:00:00"],
    ["DT", "1970-01-01-00:00:00.001"],
  ] satisfies [DataType, string][])("rejects invalid %s text %s", (type, text) => {
    expect(() => convertValue(`${textType}_TO_${type}` as ConversionFunction, text)).toThrow(
      RangeError,
    );
  });
});

it.each([
  ["STRING_TO_WSTRING", "Ä", "Ä"],
  ["WSTRING_TO_STRING", "ÿ", "ÿ"],
  ["CHAR_TO_STRING", "A", "A"],
  ["WCHAR_TO_WSTRING", "Ω", "Ω"],
  ["STRING_TO_CHAR", "ABC", "A"],
  ["WSTRING_TO_WCHAR", "ΩB", "Ω"],
  ["CHAR_TO_WCHAR", "ÿ", "ÿ"],
  ["WCHAR_TO_CHAR", "ÿ", "ÿ"],
  ["CHAR_TO_BYTE", "ÿ", 255],
  ["BYTE_TO_CHAR", 255, "ÿ"],
  ["WCHAR_TO_WORD", "\uffff", 65535],
  ["WORD_TO_WCHAR", 65535, "\uffff"],
] satisfies [ConversionFunction, ScalarValue, ScalarValue][])(
  "converts %s",
  (name, value, expected) => {
    expect(convertValue(name, value)).toBe(expected);
  },
);
it.each([
  ["STRING_TO_CHAR", ""],
  ["WSTRING_TO_WCHAR", ""],
  ["WCHAR_TO_CHAR", "Ω"],
  ["WSTRING_TO_STRING", "AΩ"],
] satisfies [ConversionFunction, string][])("rejects invalid %s", (name, value) => {
  expect(() => convertValue(name, value)).toThrow(RangeError);
});

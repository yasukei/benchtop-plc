import { describe, expect, it } from "vitest";
import { nextIndent, readStToken, type TokenizerState } from "./tokenizer.js";

function tokens(line: string, state: TokenizerState = { commentDepth: 0 }) {
  const result = [];
  for (let pos = 0; pos < line.length;) {
    const token = readStToken(line.slice(pos), state);
    expect(token.length).toBeGreaterThan(0);
    if (token.style) result.push([line.slice(pos, pos + token.length), token.style]);
    pos += token.length;
  }
  return result;
}

describe("ST highlighting tokenizer", () => {
  it("highlights reserved declarations and types from the compiler's classification", () => {
    expect(tokens("vAr_cOnFiG RETAIN date_and_time WSTRING intensity")).toEqual([
      ["vAr_cOnFiG", "keyword"],
      ["RETAIN", "keyword"],
      ["date_and_time", "typeName"],
      ["WSTRING", "typeName"],
      ["intensity", "variableName"],
    ]);
  });
  it("distinguishes case-insensitive keywords, elementary types, FB types and names", () => {
    expect(tokens("var flag: bool; timer: ton; scans: DINT;")).toEqual([
      ["var", "keyword"],
      ["flag", "variableName"],
      [":", "operator"],
      ["bool", "typeName"],
      [";", "operator"],
      ["timer", "variableName"],
      [":", "operator"],
      ["ton", "className"],
      [";", "operator"],
      ["scans", "variableName"],
      [":", "operator"],
      ["DINT", "typeName"],
      [";", "operator"],
    ]);
  });
  it("recognizes numbers, time literals, booleans and direct addresses", () => {
    expect(
      tokens("16#FF 2#10_01 1_000 1.5e-3 TIME#-1h_2m t#500ms true FALSE %IX0.0 %qx0.7"),
    ).toEqual([
      ["16#FF", "number"],
      ["2#10_01", "number"],
      ["1_000", "number"],
      ["1.5e-3", "number"],
      ["TIME#-1h_2m", "number"],
      ["t#500ms", "number"],
      ["true", "bool"],
      ["FALSE", "bool"],
      ["%IX0.0", "variableName.special"],
      ["%qx0.7", "variableName.special"],
    ]);
  });
  it("continues nested block comments across lines and resumes highlighting", () => {
    const state = { commentDepth: 0 };
    expect(tokens("(* VAR (* TRUE *)", state)).toEqual([["(* VAR (* TRUE *)", "comment"]]);
    expect(state.commentDepth).toBe(1);
    expect(tokens("still *) IF FALSE THEN // ignored", state)).toEqual([
      ["still *)", "comment"],
      ["IF", "keyword"],
      ["FALSE", "bool"],
      ["THEN", "keyword"],
      ["// ignored", "comment"],
    ]);
    expect(state.commentDepth).toBe(0);
  });
  it("keeps highlighting after incomplete and invalid input", () => {
    expect(tokens("@ % TIME# 1e+ IF")).toEqual([
      ["@", "operator"],
      ["%", "variableName.special"],
      ["TIME#", "number"],
      ["1e+", "number"],
      ["IF", "keyword"],
    ]);
    expect(tokens("diff := TRUE;")[0]).toEqual(["diff", "variableName"]);
  });
});

describe("ST indentation", () => {
  it.each([
    ["VAR", "", 2],
    ["  IF flag THEN", "", 4],
    ["  WHILE flag DO", "", 4],
    ["  REPEAT", "", 4],
    ["  IF flag THEN (* comment *)", "", 4],
    ["  scans := scans + 1;", "", 2],
    ["  ELSE", "", 4],
    ["    scans := 1;", "END_IF;", 2],
    ["IF TRUE THEN", "END_IF;", 0],
    ["// IF TRUE THEN", "", 0],
  ])("indents after %s", (before, after, expected) => {
    expect(nextIndent(before, after)).toBe(expected);
  });
});

it.each(["UINT#16#FF", "INT#-5", "REAL#1.5", "LREAL#1.5e-20", "BOOL#TRUE", "BOOL#1"])(
  "highlights %s as one number",
  (source) => {
    expect(readStToken(source + "+2", { commentDepth: 0 })).toEqual({
      length: source.length,
      style: "number",
    });
  },
);
it.each([
  "D#2024-02-29",
  "DATE#2024-02-29",
  "LD#1677-09-22",
  "LDATE#2262-04-11",
  "TOD#12:30:15.5",
  "TIME_OF_DAY#00:00:00",
  "LTOD#23:59:59.999999999",
  "LTIME_OF_DAY#00:00:00",
  "DT#2106-02-07-06:28:15",
  "DATE_AND_TIME#1970-01-01-00:00:00",
  "LDT#1677-09-21-00:12:43.145224192",
  "LDATE_AND_TIME#2262-04-11-23:47:16.854775807",
])("highlights calendar literal %s as one token", (source) => {
  expect(readStToken(source + "+T#1s", { commentDepth: 0 })).toEqual({
    length: source.length,
    style: "number",
  });
});

it.each([
  "D#2026-1-5",
  "DATE#2_026-01-0_5",
  "TOD#8:05:00",
  "TIME_OF_DAY#8:5:0.1_20",
  "LTOD#15:36:55.360_227_400",
  "DT#2_026-1-5-8:5:0",
  "LDT#1_969-12-31-23:59:59.999_999_999",
])("highlights unpadded and separated calendar fields: %s", (source) => {
  expect(readStToken(source + "-T#1s", { commentDepth: 0 })).toEqual({
    length: source.length,
    style: "number",
  });
});

it("highlights declared type names case insensitively without changing comments", () => {
  const types = new Set(["STATE"]);
  expect(readStToken("state;", { commentDepth: 0 }, types)).toEqual({
    length: 5,
    style: "typeName",
  });
  expect(readStToken("// State", { commentDepth: 0 }, types).style).toBe("comment");
  expect(readStToken("Other", { commentDepth: 0 }, types).style).toBe("variableName");
});

it("tokenizes array brackets as operators", () => {
  for (const bracket of ["[", "]"])
    expect(readStToken(bracket, { commentDepth: 0 })).toEqual({ length: 1, style: "operator" });
});

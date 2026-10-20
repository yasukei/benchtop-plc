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

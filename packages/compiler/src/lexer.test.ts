import { describe, expect, it } from "vitest";
import { isElementaryTypeName, isKeyword, lex } from "./index.js";

describe("ST lexer", () => {
  it.each([
    ["var", true, false],
    ["eNd_iF", true, false],
    ["VAR_CONFIG", true, false],
    ["bool", true, true],
    ["wStRiNg", true, true],
    ["DATE_AND_TIME", true, true],
    ["ton", false, false],
    ["intensity", false, false],
  ])("shares case-insensitive keyword and type classification for %s", (name, keyword, type) => {
    expect(isKeyword(name)).toBe(keyword);
    expect(isElementaryTypeName(name)).toBe(type);
    expect(lex(name).tokens?.[0]?.kind).toBe(keyword ? "keyword" : "identifier");
  });

  it.each([
    ["0", "integer", 0],
    ["123", "integer", 123],
    ["12_345", "integer", 12345],
    ["2#1010_0011", "integer", 163],
    ["16#fF_a0", "integer", 65440],
    ["1.5", "real", 1.5],
    ["1e999", "real", 0],
    ["9007199254740993", "integer", 9007199254740992],
    ["1.0e3", "real", 1000],
    ["1.0E-3", "real", 0.001],
    ["1.0e+3", "real", 1000],
    ["1e2", "real", 100],
    ["1_000.2_5e1_0", "real", 10002500000000],
    ["T#500ms", "time", 500],
    ["TIME#1d2h3m4s5ms", "time", 93784005],
    ["t#-1h30m", "time", -5400000],
    ["time#+2s", "time", 2000],
    ["T#1_000ms", "time", 1000],
    ["T#1.5s", "time", 1500],
    ["T#1h_30m", "time", 5400000],
    ["T#1d_2h", "time", 93600000],
    ["time#-1d_2h_3m_4s_5ms", "time", -93784005],
    ["T#1h_30.5m", "time", 5430000],
    ["T#1h30.5m", "time", 5430000],
    ["T#1s_2_0.5ms", "time", 1020.5],
    ["T#0ms", "time", 0],
    ["T#-0ms", "time", 0],
    ["T#1D", "time", 86400000],
    ["T#1h", "time", 3600000],
    ["T#1m", "time", 60000],
    ["T#1s", "time", 1000],
    ["TrUe", "boolean", true],
    ["false", "boolean", false],
  ])("lexes %s", (source, kind, value) => {
    const result = lex(source);
    expect(result.diagnostics).toEqual([]);
    expect(result.tokens).toEqual([
      {
        kind,
        text: source,
        key: source.toUpperCase(),
        value,
        span: { line: 1, column: 1, endLine: 1, endColumn: source.length + 1 },
      },
      {
        kind: "eof",
        text: "",
        key: "",
        span: { line: 1, column: source.length + 1, endLine: 1, endColumn: source.length + 1 },
      },
    ]);
  });

  it.each([
    "2#102",
    "8#8",
    "16#G",
    "3#10",
    "2#",
    "1__0",
    "1_",
    "1._5",
    "1.",
    "1e",
    "1.0e+",
    "123abc",
    "1.2.3",
    "8#7_7",
    "T#",
    "T#-",
    "T#1",
    "T#1xs",
    "T#1s1s",
    "T#1ms1s",
    "T#_1s",
    "T#1_s",
    "T#1s_",
    "T#1h__30m",
    "T#1.5h30m",
    "T#1.5h_30m",
    "T#1.0h0m",
    "T#1h_30.5m_1s",
    "T#1s_1s",
    "T#1ms_1s",
  ])("reports a malformed number for %s", (literal) => {
    expect(lex(literal)).toEqual({
      tokens: null,
      diagnostics: [
        {
          code: "lex.malformed-number",
          severity: "error",
          args: { literal },
          span: { line: 1, column: 1, endLine: 1, endColumn: literal.length + 1 },
        },
      ],
    });
  });

  it("keeps original names, canonical keys and longest-match punctuation", () => {
    const result = lex("pRoGrAm Main_1 x:=16#FE+1; 1..3 <= >= <> & %ix12.3 %QX0.7");
    expect(result.diagnostics).toEqual([]);
    expect(result.tokens?.map(({ kind, text, key }) => [kind, text, key])).toEqual([
      ["keyword", "pRoGrAm", "PROGRAM"],
      ["identifier", "Main_1", "MAIN_1"],
      ["identifier", "x", "X"],
      ["symbol", ":=", ":="],
      ["integer", "16#FE", "16#FE"],
      ["symbol", "+", "+"],
      ["integer", "1", "1"],
      ["symbol", ";", ";"],
      ["integer", "1", "1"],
      ["symbol", "..", ".."],
      ["integer", "3", "3"],
      ["symbol", "<=", "<="],
      ["symbol", ">=", ">="],
      ["symbol", "<>", "<>"],
      ["symbol", "&", "&"],
      ["address", "%ix12.3", "%IX12.3"],
      ["address", "%QX0.7", "%QX0.7"],
      ["eof", "", ""],
    ]);
  });

  it("separates signs and arithmetic from literal contents", () => {
    expect(lex("-1 +2 T#1s+T#2s T#-1ms-1 16#E-2").tokens?.map(({ text }) => text)).toEqual([
      "-",
      "1",
      "+",
      "2",
      "T#1s",
      "+",
      "T#2s",
      "T#-1ms",
      "-",
      "1",
      "16#E",
      "-",
      "2",
      "",
    ]);
  });

  it.each([
    "%IX0",
    "%Q0.1",
    "%ZX0.0",
    "%IXa.0",
    "%IX0.0foo",
    "%IX0.0.1",
    "%",
    "%IX9007199254740993.0",
  ])("rejects malformed address %s", (address) => {
    expect(lex(address)).toEqual({
      tokens: null,
      diagnostics: [
        {
          code: "lex.malformed-direct-address",
          severity: "error",
          args: { address },
          span: { line: 1, column: 1, endLine: 1, endColumn: address.length + 1 },
        },
      ],
    });
  });

  it.each(["\n", "\r\n", "\r"])("tracks lines through nested comments with %j", (newline) => {
    const source = `// ignored (*${newline}(* outer${newline} (* nested // ignored *)${newline} end *) Foo // tail`;
    const result = lex(source);
    expect(result.diagnostics).toEqual([]);
    expect(result.tokens?.[0]).toEqual({
      kind: "identifier",
      text: "Foo",
      key: "FOO",
      span: { line: 4, column: 9, endLine: 4, endColumn: 12 },
    });
    expect(result.tokens?.[1]?.span).toEqual({ line: 4, column: 20, endLine: 4, endColumn: 20 });
  });

  it("reports an unterminated nested comment from its outer opening to EOF", () => {
    expect(lex("\n (* a\n(* b *)")).toEqual({
      tokens: null,
      diagnostics: [
        {
          code: "lex.unterminated-comment",
          severity: "error",
          args: {},
          span: { line: 2, column: 2, endLine: 3, endColumn: 8 },
        },
      ],
    });
  });

  it("reports the invalid character's exact position", () => {
    expect(lex("// comment\n  @")).toEqual({
      tokens: null,
      diagnostics: [
        {
          code: "lex.invalid-character",
          severity: "error",
          args: { character: "@" },
          span: { line: 2, column: 3, endLine: 2, endColumn: 4 },
        },
      ],
    });
  });

  it("handles empty input and comments ending at EOF", () => {
    for (const source of ["", "// tail", "(* complete *)", "(* (* nested *) *)"]) {
      expect(lex(source).diagnostics).toEqual([]);
      expect(lex(source).tokens).toHaveLength(1);
    }
  });
});

it("leaves out-of-range durations to semantic validation", () => {
  expect(lex("T#9007199254740993ms").diagnostics).toEqual([]);
  const tokens = lex(`T#${"9".repeat(309)}ms`).tokens;
  expect(tokens?.[0]?.value).toBe(0);
  expect(JSON.parse(JSON.stringify(tokens))).toStrictEqual(tokens);
});

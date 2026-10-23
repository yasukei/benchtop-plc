import { describe, expect, it } from "vitest";
import { compile, compileProject, lex } from "./index.js";

const program = (declarations: string, body = "") =>
  compile(`PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`);

describe("string literals and declarations", () => {
  it.each([
    ["'A$$B$'C$L$N$P$R$T$41'", "A$B'C\n\n\f\r\tA"],
    ['"$00C4$0024$"$l$n$p$r$t"', 'Ä$"\n\n\f\r\t'],
    ["'(* not a comment *) // either'", "(* not a comment *) // either"],
    ["'\"'", '"'],
    ['"\'"', "'"],
  ])("decodes %s", (text, value) => {
    expect(lex(text).tokens?.[0]).toMatchObject({ kind: "string", text, value });
  });

  it.each([
    ["'abc", "lex.unterminated-string"],
    ["'a\nb'", "lex.unterminated-string"],
    ["'a\rb'", "lex.unterminated-string"],
    ["'$Q'", "lex.invalid-string-escape"],
    ["'$4'", "lex.invalid-string-escape"],
    ['"$123"', "lex.invalid-string-escape"],
    [`'$"'`, "lex.invalid-string-escape"],
    ["'Ā'", "lex.invalid-string-character"],
  ])("reports %s using a diagnostic code", (text, code) => {
    const result = program("s : STRING;", `s := ${text};`);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics[0]).toMatchObject({ code, pou: "Main" });
  });

  it("supports defaults, typed literals, contextual characters and constants", () => {
    const result = compileProject(
      [
        `PROGRAM Main
      VAR CONSTANT Code : CHAR := 'A'; Message : MessageType := 'OK'; END_VAR
      VAR s : STRING; wide : WSTRING; ch : CHAR; wch : WCHAR; shortText : MessageType; END_VAR
      ch := Code; wch := "Ä"; s := STRING#'Hello'; wide := WSTRING#"Hi";
      ch := CHAR#'$FF'; wch := WCHAR#"$FFFF"; shortText := Message;
      END_PROGRAM`,
      ],
      ["TYPE MessageType : STRING[20] := 'Default'; END_TYPE"],
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.variables.map((v) => v.initialValue)).toEqual([
      "",
      "",
      "\0",
      "\0",
      "Default",
    ]);
    expect(result.ir?.types?.[0]).toMatchObject({
      definition: { kind: "alias", type: { kind: "string", base: "STRING", length: 20 } },
    });
  });

  it.each([
    ["s : STRING[5] := 'Hello world';", ""],
    ["s : STRING[5];", "s := 'Hello world';"],
    ["s : STRING;", `s := '${"x".repeat(81)}';`],
    ["s : STRING[0];", ""],
    ["s : WSTRING[1025];", ""],
    ["s : INT[20];", ""],
    ["s : CHAR := '';", ""],
    ['s : WCHAR := "ab";', ""],
    ['s : STRING := STRING#"a";', ""],
    ["s : WSTRING := WSTRING#'a';", ""],
  ])("rejects invalid capacity or character constant: %s %s", (declarations, body) => {
    const result = program(declarations, body);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "type.invalid-constant" }),
    );
  });

  it("accepts the maximum capacity and rejects overlong aliases and constants", () => {
    expect(program(`s : STRING[1024] := '${"x".repeat(1024)}';`).diagnostics).toEqual([]);
    for (const type of [
      "TYPE Message : STRING[2] := 'long'; END_TYPE",
      "TYPE Message : WSTRING[1025]; END_TYPE",
    ]) {
      expect(compileProject(["PROGRAM Main END_PROGRAM"], [type]).ir).toBeUndefined();
    }
    expect(
      compile(`PROGRAM Main VAR CONSTANT s : STRING[2] := 'long'; END_VAR END_PROGRAM`).ir,
    ).toBeUndefined();
  });

  it.each([
    "s := wide;",
    "ch := s;",
    "wch := ch;",
    "s := s + s;",
    "ok := s = wide;",
    "s := SEL(TRUE, s, wide);",
  ])("rejects unsupported conversion or operation %s", (body) => {
    expect(
      program("s : STRING; wide : WSTRING; ch : CHAR; wch : WCHAR; ok : BOOL;", body).ir,
    ).toBeUndefined();
  });

  it.each(["CHAR", "WCHAR", "STRING", "WSTRING"])("reserves %s", (name) => {
    expect(program(`${name} : INT;`).ir).toBeUndefined();
    expect(
      compileProject(["PROGRAM Main END_PROGRAM"], [`TYPE ${name} : INT; END_TYPE`]).ir,
    ).toBeUndefined();
  });
});

it.each([
  "REF_TO",
  "REF",
  "NULL",
  "LEN",
  "LEFT",
  "RIGHT",
  "MID",
  "CONCAT",
  "INSERT",
  "DELETE",
  "REPLACE",
  "FIND",
  "LOWER_BOUND",
  "UPPER_BOUND",
  "TO_STRING",
  "TO_WSTRING",
  "BOOL_TO_STRING",
  "WSTRING_TO_LINT",
  "CHAR_TO_BYTE",
  "WORD_TO_WCHAR",
])("reserves ADR 0015 name %s in declarations, POUs and types", (name) => {
  expect(program(`${name} : INT;`).ir).toBeUndefined();
  expect(compileProject([`PROGRAM ${name} END_PROGRAM`]).ir).toBeUndefined();
  expect(
    compileProject(["PROGRAM Main END_PROGRAM"], [`TYPE ${name} : INT; END_TYPE`]).ir,
  ).toBeUndefined();
});

it.each(["ch := MOVE('A');", "ch := SEL(TRUE, 'A', 'B');", "ch := MUX(0, 'A', 'B');"])(
  "keeps destination types out of larger string expressions: %s",
  (body) => {
    const result = program("ch : CHAR;", body);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "type.assign-mismatch" }),
    );
  },
);

it("rejects a capacity suffix on a named alias", () => {
  const result = compileProject(
    ["PROGRAM Main END_PROGRAM"],
    ["TYPE SmallText : STRING[2]; END_TYPE", "TYPE Invalid : SmallText[3]; END_TYPE"],
  );
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "type.invalid-constant" }),
  );
});

import { expect, it } from "vitest";
import { compile, compileProject } from "./index.js";

const program = (body: string) =>
  compile(
    `PROGRAM Main VAR s : STRING; w : WSTRING; ch : CHAR; wc : WCHAR; n : INT; b : BYTE; END_VAR ${body} END_PROGRAM`,
  );

it.each([
  "s := LEN('a');",
  "n := CONCAT('a', 'b');",
  "s := CONCAT('a');",
  "n := LEN('a', 'b');",
  "s := CONCAT(s, w);",
  "n := FIND(s, w);",
  "s := INSERT(s, w, 1);",
  "s := REPLACE(s, w, 1, 1);",
  "s := LEFT(s, 1.0);",
  "s := MID(s, 1, TRUE);",
  "s := DELETE(s, T#1s, 1);",
  "n := LEN(n);",
  "s := INT_TO_STRING(s);",
  "n := STRING_TO_INT(n);",
  "s := CHAR_TO_WSTRING(ch);",
  "ch := STRING_TO_WCHAR(s);",
  "b := WCHAR_TO_BYTE(wc);",
])("rejects invalid string call %s", (body) => {
  const result = program(body);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(true);
});

it("keeps independently typed integer positions outside the string common-type group", () => {
  const result = program(
    "s := INSERT(s, 'X', ULINT#1); s := REPLACE(s, 'X', USINT#2, LINT#1); n := FIND(s, 'X');",
  );
  expect(result.diagnostics).toEqual([]);
  expect(
    result.ir?.body.map((statement) => statement.kind === "assignment" && statement.value.dataType),
  ).toEqual(["STRING", "STRING", "INT"]);
});

it("accepts ANY_CHAR, ANY_STRING and ANY_CHARS selection and comparison rules", () => {
  const result = program(`s := SEL(TRUE, ch, s); w := MUX(0, wc, w); s := MOVE(s);
    s := MAX(ch, s); w := MIN(wc, w); w := LIMIT(wc, w, "z");
    ch := SEL(TRUE, ch, CHAR#'X'); wc := MOVE(wc); n := LEN(s);`);
  expect(result.diagnostics).toEqual([]);
  for (const body of [
    "s := SEL(TRUE, ch, w);",
    "s := MUX(0, s, w);",
    "n := EQ(s, w);",
    "s := MAX(s, wc);",
  ])
    expect(program(body).ir).toBeUndefined();
});

it("keeps elementary aliases and subranges usable, while rejecting enum conversions", () => {
  const result = compileProject(
    [
      "PROGRAM Main VAR value : Count; s : Text; END_VAR s := INT_TO_STRING(value); s := LEFT(s, value); END_PROGRAM",
    ],
    ["TYPE Count : INT (0..10); END_TYPE", "TYPE Text : STRING[200]; END_TYPE"],
  );
  expect(result.diagnostics).toEqual([]);
  const invalid = compileProject(
    ["PROGRAM Main VAR value : Mode; s : STRING; END_VAR s := TO_STRING(value); END_PROGRAM"],
    ["TYPE Mode : (Idle, Active); END_TYPE"],
  );
  expect(invalid.ir).toBeUndefined();
  expect(invalid.diagnostics).toContainEqual(
    expect.objectContaining({ code: "call.argument-type" }),
  );
});

it.each(["LEN", "CONCAT", "STRING_TO_INT", "TO_STRING", "CHAR_TO_BYTE", "TO_CHAR", "TO_WCHAR"])(
  "reserves %s in the shared standard namespace",
  (name) => {
    expect(
      compileProject([
        `PROGRAM Main END_PROGRAM`,
        `FUNCTION ${name} : INT ${name} := 0; END_FUNCTION`,
      ]).ir,
    ).toBeUndefined();
    expect(
      compileProject(["PROGRAM Main END_PROGRAM"], [`TYPE ${name} : INT; END_TYPE`]).ir,
    ).toBeUndefined();
  },
);

it.each([
  ["n := LEN(ch);", "INT"],
  ["s := LEFT(ch, 0);", "STRING"],
  ["s := RIGHT(CHAR#'X', 0);", "STRING"],
  ["s := MID(ch, 0, 1);", "STRING"],
  ["s := DELETE(ch, 1, 1);", "STRING"],
  ["s := CONCAT(ch, CHAR#'X');", "STRING"],
  ["s := CONCAT(s, ch, CHAR#'X');", "STRING"],
  ["s := INSERT(ch, CHAR#'X', 0);", "STRING"],
  ["s := REPLACE(ch, CHAR#'X', 0, 1);", "STRING"],
  ["n := FIND(s, ch);", "INT"],
  ["n := LEN(wc);", "INT"],
  ["w := LEFT(wc, 0);", "WSTRING"],
  ['w := RIGHT(WCHAR#"Ω", 0);', "WSTRING"],
  ["w := MID(wc, 0, 1);", "WSTRING"],
  ["w := DELETE(wc, 1, 1);", "WSTRING"],
  ['w := CONCAT(wc, WCHAR#"Ω");', "WSTRING"],
  ['w := CONCAT(w, wc, WCHAR#"Ω");', "WSTRING"],
  ['w := INSERT(wc, WCHAR#"Ω", 0);', "WSTRING"],
  ['w := REPLACE(wc, WCHAR#"Ω", 0, 1);', "WSTRING"],
  ["n := FIND(w, wc);", "INT"],
])("widens string-function character inputs in %s", (body, expected) => {
  const result = program(body);
  expect(result.diagnostics).toEqual([]);
  const statement = result.ir?.body[0];
  expect(statement?.kind).toBe("assignment");
  if (statement?.kind !== "assignment") throw new Error("Expected assignment");
  expect(statement.value).toMatchObject({ kind: "functionCall", dataType: expected });
});

it.each([
  "s := CONCAT(ch, wc);",
  's := CONCAT(s, WCHAR#"X");',
  "s := INSERT(s, wc, 0);",
  "n := FIND(w, ch);",
  "s := LEFT(wc, 1);",
  "w := RIGHT(ch, 1);",
  "s := REPLACE(ch, wc, 1, 1);",
  "ch := CONCAT(ch, ch);",
  "ch := LEFT(ch, 1);",
  "wc := CONCAT(wc, wc);",
  "wc := MID(wc, 1, 1);",
])("keeps string-function widths and result types distinct in %s", (body) => {
  expect(program(body).ir).toBeUndefined();
});

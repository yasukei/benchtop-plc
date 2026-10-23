import { describe, expect, it } from "vitest";
import { compile, compileProject } from "./compile.js";

const program = (declarations: string, body = "") =>
  `PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`;

describe("arrays", () => {
  it("compiles bounds using earlier POU constants and flattens row-major leaves", () => {
    const result = compile(
      `PROGRAM Main VAR CONSTANT N : INT := 3; END_VAR VAR a : ARRAY[-1..N, 0..1] OF INT := [2(1, 2)]; END_VAR a[N, 1] := a[-1, 0]; END_PROGRAM`,
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.variables.map((v) => v.name)).toEqual([
      "A[-1,0]",
      "A[-1,1]",
      "A[0,0]",
      "A[0,1]",
      "A[1,0]",
      "A[1,1]",
      "A[2,0]",
      "A[2,1]",
      "A[3,0]",
      "A[3,1]",
    ]);
    expect(result.ir?.variables.map((v) => v.initialValue)).toEqual([1, 2, 1, 2, 0, 0, 0, 0, 0, 0]);
  });
  it.each([
    ["a : ARRAY[2..1] OF INT;", ""],
    ["a : ARRAY[0..10000] OF INT;", ""],
    ["a : ARRAY[1..101] OF ARRAY[1..100] OF INT;", ""],
    ["a : ARRAY[0..1,0..1,0..1,0..1] OF INT;", ""],
    ["a : ARRAY[LINT#2147483648..LINT#2147483649] OF INT;", ""],
    ["a : ARRAY[-2147483649..0] OF INT;", ""],
    ["n : INT := 2; a : ARRAY[1..n] OF INT;", ""],
    ["a : ARRAY[1..2] OF INT := [1,2,3];", ""],
    ["a : ARRAY[1..2] OF INT := [2.5(0)];", ""],
    ["a : ARRAY[1..2] OF INT;", "a[3] := 1;"],
    ["a : ARRAY[1..2] OF INT;", "a[TRUE] := 1;"],
    ["a : ARRAY[1..2] OF INT;", "a[1,2] := 1;"],
    ["a : ARRAY[1..2] OF INT; b : ARRAY[0..1] OF INT;", "a := b;"],
    ["a : ARRAY[1..2] OF INT; b : ARRAY[1..2] OF INT (0..100);", "a := b;"],
    ["a : ARRAY[1..2] OF INT; b : BOOL;", "b := a = a;"],
    ["a : ARRAY[1..2] OF INT; n : INT;", "n := ABS(a);"],
  ])("rejects invalid arrays: %s %s", (decl, body) => {
    const result = compile(program(decl, body));
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });
  it("resolves named arrays, forward dependencies and defaults", () => {
    const result = compileProject(
      [
        program(
          "a : Table; b : ARRAY[1..3] OF INT;",
          "b := SEL(TRUE, a, a); b := MOVE(MUX(0, a, b));",
        ),
      ],
      ["TYPE Table : ARRAY[1..3] OF INT := [1, 2, 1(3)]; END_TYPE"],
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.variables.slice(0, 3).map((v) => v.initialValue)).toEqual([1, 2, 3]);
  });
});

it.each([
  [
    "PROGRAM Main VAR a : ARRAY[1..2] OF INT; i : INT; END_VAR FOR i := a TO 3 DO END_FOR; END_PROGRAM",
    [],
  ],
  ["PROGRAM Main VAR a : ARRAY[1..2] OF INT; END_VAR CASE a OF ELSE END_CASE; END_PROGRAM", []],
  ["PROGRAM Main VAR CONSTANT a : ARRAY[1..2] OF INT := [1,2]; END_VAR END_PROGRAM", []],
  ["PROGRAM Main VAR a : ARRAY[1..2] OF TON; END_VAR END_PROGRAM", []],
  ["PROGRAM Main END_PROGRAM", ["TYPE Table : ARRAY[1..2] OF Table; END_TYPE"]],
  [
    "PROGRAM Main END_PROGRAM",
    ["TYPE A : ARRAY[1..2] OF B; END_TYPE", "TYPE B : ARRAY[1..2] OF A; END_TYPE"],
  ],
  ["PROGRAM Main END_PROGRAM", ["TYPE Table : ARRAY[N..2] OF INT; END_TYPE"]],
  [
    "PROGRAM Main END_PROGRAM",
    ["TYPE Table : ARRAY[LINT#2147483648..LINT#2147483649] OF INT; END_TYPE"],
  ],
  [
    "PROGRAM Main END_PROGRAM",
    ["TYPE Table : ARRAY[1..2] OF INT; END_TYPE", "TYPE Alias : Table := [1,2,3]; END_TYPE"],
  ],
])("rejects restricted array declarations without crashing", (source, types) => {
  const result = compileProject([source], types);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
});

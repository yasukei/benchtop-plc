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
    expect(result.ir?.variables.map((v) => v.name.replace(/^mainInstance\./, ""))).toEqual([
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
  ["PROGRAM Main VAR_TEMP a : ARRAY[1..2] OF TON; END_VAR END_PROGRAM", []],
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

it.each([
  {
    declarations: "x : INT;",
    body: "x[1] := 2;",
    code: "type.not-array",
    args: { type: "INT" },
  },
  {
    declarations: "a : ARRAY[1..3] OF INT;",
    body: "a[1,2] := 2;",
    code: "type.array-index-count",
    args: { expected: 1, found: 2 },
  },
  {
    declarations: "a : ARRAY[1..3,0..1] OF INT;",
    body: "a[1] := 2;",
    code: "type.array-index-count",
    args: { expected: 2, found: 1 },
  },
  {
    declarations: "a : ARRAY[1..3] OF INT; r : REAL;",
    body: "a[r] := 2;",
    code: "type.array-index-not-integer",
    args: { type: "REAL" },
  },
  {
    declarations: "a : ARRAY[1..3] OF INT;",
    body: "a[TRUE] := 2;",
    code: "type.array-index-not-integer",
    args: { type: "BOOL" },
  },
  {
    declarations: "a : ARRAY[1..3] OF INT; stateValue : State;",
    body: "a[stateValue] := 2;",
    types: ["TYPE State : (Idle, Running); END_TYPE"],
    code: "type.array-index-not-integer",
    args: { type: { kind: "named", name: "State" } },
  },
  {
    declarations: "a, indices : ARRAY[1..3] OF INT;",
    body: "a[indices] := 2;",
    code: "type.array-index-not-integer",
    args: { type: { kind: "array", dimensions: [{ lower: 1, upper: 3 }], element: "INT" } },
  },
  {
    declarations: "a : ARRAY[1..3] OF ARRAY[1..2] OF WORD;",
    body: "a[1].3 := TRUE;",
    code: "type.invalid-bit-access",
    args: {
      type: { kind: "array", dimensions: [{ lower: 1, upper: 2 }], element: "WORD" },
      bit: 3,
    },
  },
  {
    declarations: "a : ARRAY[1..3] OF INT;",
    body: "a[1].3 := TRUE;",
    code: "type.invalid-bit-access",
    args: { type: "INT", bit: 3 },
  },
  {
    declarations: "a : ARRAY[1..3] OF INT := 5;",
    body: "",
    code: "type.array-initializer-required",
    args: { type: { kind: "array", dimensions: [{ lower: 1, upper: 3 }], element: "INT" } },
  },
  {
    declarations: "a : Table := 5;",
    body: "",
    types: ["TYPE Table : ARRAY[1..3] OF INT; END_TYPE"],
    code: "type.array-initializer-required",
    args: { type: { kind: "named", name: "Table" } },
  },
  {
    declarations: "a : ARRAY[1..3] OF INT;",
    body: "a[4] := 2;",
    code: "type.invalid-constant",
    args: {},
  },
  {
    declarations: "a : ARRAY[1..3] OF INT;",
    body: "a[missing] := 2;",
    code: "name.undeclared",
    args: { name: "missing" },
  },
])(
  "reports $code with specific array error arguments",
  ({ declarations, body, code, args, ...context }) => {
    const result = compileProject(
      [program(declarations, body)],
      "types" in context ? context.types : [],
    );
    expect(result.ir).toBeUndefined();
    expect(
      result.diagnostics.map((diagnostic) => ({ code: diagnostic.code, args: diagnostic.args })),
    ).toEqual([{ code, args }]);
  },
);

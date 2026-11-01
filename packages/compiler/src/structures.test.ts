import { describe, expect, it } from "vitest";
import { compileProject, parseDataType, parsePou } from "./index.js";

const point = "TYPE Point : STRUCT x : REAL; y : REAL := 1.0; END_STRUCT; END_TYPE";
const program = (declarations: string, body = "") =>
  `PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`;
const compile = (declarations: string, body = "", types = [point]) =>
  compileProject([program(declarations, body)], types);

describe("structures", () => {
  it("parses declarations, nested initializers and alternating access chains", () => {
    const parsed = parseDataType(point);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.ast?.members).toHaveLength(2);
    const ast = parsePou(program("a : ARRAY[1..3] OF Point := [(x := 1.0)];", "a[2].x := a[1].y;"));
    expect(ast.diagnostics).toEqual([]);
    expect(ast.ast?.declarations[0]?.initializer).toMatchObject({
      kind: "arrayInitializer",
      items: [{ values: [{ kind: "structureInitializer", members: [{ name: { key: "X" } }] }] }],
    });
    expect(ast.ast?.body[0]).toMatchObject({
      kind: "assignment",
      target: { kind: "field", object: { kind: "index" } },
    });
  });

  it("resolves forward members, aliases, nested defaults and row paths", () => {
    const result = compile(
      "r : Recipe := (steps := [(x := 2.0)]);",
      "r.steps[1].x := r.steps[2].y;",
      [
        "TYPE Recipe : STRUCT steps : ARRAY[1..2] OF AliasPoint; END_STRUCT; END_TYPE",
        "TYPE AliasPoint : Point; END_TYPE",
        point,
      ],
    );
    expect(result.diagnostics).toEqual([]);
    expect(
      result.ir?.variables.map((v) => [v.name.replace(/^mainInstance\./, ""), v.initialValue]),
    ).toEqual([
      ["R.STEPS[1].X", 2],
      ["R.STEPS[1].Y", 1],
      ["R.STEPS[2].X", 0],
      ["R.STEPS[2].Y", 1],
    ]);
    expect(result.ir?.composites?.map((v) => v.name.replace(/^mainInstance\./, ""))).toEqual([
      "R",
      "R.STEPS",
      "R.STEPS[1]",
      "R.STEPS[2]",
    ]);
    expect(JSON.parse(JSON.stringify(result.ir))).toEqual(result.ir);
  });

  it("distinguishes member names from bit constants and numeric bit selectors", () => {
    const result = compileProject(
      [
        `PROGRAM Main VAR CONSTANT X : INT := 3; END_VAR VAR s : Settings; w : WORD; END_VAR s.x := w.X; s.flags.3 := s.x; END_PROGRAM`,
      ],
      ["TYPE Settings : STRUCT x : BOOL; flags : WORD; END_STRUCT; END_TYPE"],
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.programs[0]!.body).toMatchObject([
      { target: { kind: "structureMember", member: 0 }, value: { kind: "bit", bit: 3 } },
      { target: { kind: "elementBit", bit: 3 }, value: { kind: "structureMember", member: 0 } },
    ]);
  });

  it.each([
    ["p : Point := (z := 1.0);", ""],
    ["p : Point := (x := 1.0, X := 2.0);", ""],
    ["p : Point := [1.0];", ""],
    ["p : Point;", "p.z := 1.0;"],
    ["p : Point;", "p.3 := TRUE;"],
    ["p : Point; b : BOOL;", "b := p = p;"],
    ["p : Point;", "p := -p;"],
    ["p : Point; x : INT;", "x := ABS(p);"],
    ["p : Point; x : INT;", "x := p + 1;"],
    ["p : Point; a : ARRAY[1..2] OF INT;", "a[p] := 1;"],
    ["p : Point; x : INT;", "x := p;"],
    ["p : Point; x : INT;", "p := x;"],
    ["p : Point;", "p := (x := 1.0);"],
  ])("rejects invalid use: %s %s", (declarations, body) => {
    const result = compile(declarations, body);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it.each(["p := q;", "p := SEL(TRUE, p, q);", "p := MUX(0, p, q);", "p := MOVE(q);"])(
    "requires name equivalence for %s",
    (body) => {
      const result = compile("p : Point; q : Other;", body, [
        point,
        point.replace("Point", "Other"),
      ]);
      expect(result.ir).toBeUndefined();
      expect(
        result.diagnostics.some(
          (d) => d.code === "type.assign-mismatch" || d.code === "call.argument-type",
        ),
      ).toBe(true);
    },
  );

  it.each([
    ["TYPE Self : STRUCT child : Self; END_STRUCT; END_TYPE"],
    ["TYPE Self : STRUCT child : ARRAY[1..2] OF Self; END_STRUCT; END_TYPE"],
    [
      "TYPE A : STRUCT child : B; END_STRUCT; END_TYPE",
      "TYPE B : STRUCT child : A; END_STRUCT; END_TYPE",
    ],
    ["TYPE A : STRUCT child : B; END_STRUCT; END_TYPE", "TYPE B : ARRAY[1..2] OF A; END_TYPE"],
    ["TYPE A : STRUCT x : INT; X : INT; END_STRUCT; END_TYPE"],
    ["TYPE A : STRUCT x : TON; END_STRUCT; END_TYPE"],
    ["TYPE A : STRUCT END_STRUCT; END_TYPE"],
    ["TYPE A : STRUCT x : Missing; END_STRUCT; END_TYPE"],
    ["TYPE A : STRUCT x : ARRAY[1..10000] OF INT; y : INT; END_STRUCT; END_TYPE"],
    ["TYPE A : STRUCT x : INT (0..10) := 11; END_STRUCT; END_TYPE"],
    ["TYPE A : STRUCT s : STRING[2] := 'long'; END_STRUCT; END_TYPE"],
  ])("rejects invalid or recursive type definitions: %s", (...types) => {
    const result = compileProject([program("")], types);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it("rejects aggregate constants and accepts aggregate POU interfaces", () => {
    for (const source of [
      "PROGRAM Main VAR CONSTANT p : Point; END_VAR END_PROGRAM",
      "FUNCTION F : Point F.x := 0.0; END_FUNCTION",
      "FUNCTION F : INT VAR_INPUT p : Point; END_VAR F := 0; END_FUNCTION",
      "FUNCTION_BLOCK F VAR_OUTPUT p : Point; END_VAR END_FUNCTION_BLOCK",
    ]) {
      const result = compileProject(
        [
          source.includes("PROGRAM") ? source : program(""),
          ...(!source.includes("PROGRAM") ? [source] : []),
        ],
        [point],
      );
      if (source.includes("CONSTANT")) {
        expect(result.ir).toBeUndefined();
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({ code: "decl.constant-type" }),
        );
      } else {
        expect(result.diagnostics).toEqual([]);
        expect(result.ir).toBeDefined();
      }
    }
  });
});

it("keeps member names in a separate namespace and supports empty/defaulted initializers", () => {
  const result = compileProject(
    [program("r : RecordType := (); r2 : RecordType;", "r2 := MOVE(r);")],
    [
      "TYPE State : (Idle, Running); END_TYPE",
      "TYPE RecordType : STRUCT state : State := Running; recordType : REAL := 2.0; END_STRUCT; END_TYPE",
    ],
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.ir?.variables.map((v) => v.initialValue)).toEqual([1, 2, 1, 2]);
});

it("names the original member when its default is not constant", () => {
  const result = compileProject(
    [program("")],
    ["TYPE RecordType : STRUCT x : INT := GetValue(); END_STRUCT; END_TYPE"],
  );
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "call.unknown-function", args: { name: "GetValue" } }),
  );
});

it.each(["TON", "ton", "CTU_LINT"])(
  "explains the function block member restriction at the type name: %s",
  (type) => {
    const result = compileProject(
      [program("")],
      [`TYPE S : STRUCT\n  timerValue : ${type};\nEND_STRUCT; END_TYPE`],
    );
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toEqual([
      {
        code: "decl.structure-member-type",
        severity: "error",
        pou: "S",
        sourceKind: "dataType",
        sourceIndex: 0,
        span: { line: 2, column: 16, endLine: 2, endColumn: 16 + type.length },
        args: { name: type },
      },
    ]);
  },
);

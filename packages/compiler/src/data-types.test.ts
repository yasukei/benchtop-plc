import { describe, expect, it } from "vitest";
import { compileProject, parseDataType } from "./index.js";

const color = "TYPE Color : (Red, Green, Blue); END_TYPE";
const percent = "TYPE Percent : INT (0..100); END_TYPE";
const program = (declarations: string, body = "") =>
  `PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`;
const compile = (declarations: string, body = "", types = [color, percent], pous: string[] = []) =>
  compileProject([program(declarations, body), ...pous], types);
const codes = (result: ReturnType<typeof compile>) =>
  result.diagnostics.map((diagnostic) => diagnostic.code);

it.each(["DIV(7, 2)", "MOVE(7)", "SEL(TRUE, 7, 2)", "MUX(0, 7, 2)"])(
  "keeps elementary generic arguments independent of a narrowing assignment target: %s",
  (expression) => {
    for (const type of ["REAL", "SINT"]) {
      const result = compile(`target : ${type};`, `target := ${expression};`, []);
      expect(codes(result)).toContain("type.assign-mismatch");
      expect(result.ir).toBeUndefined();
    }
  },
);

describe("data type sources", () => {
  it("parses one declaration and rejects trailing declarations and malformed headers", () => {
    expect(parseDataType(color).ast).toMatchObject({
      name: { name: "Color" },
      values: [{ name: { name: "Red" } }, { name: { name: "Green" } }, { name: { name: "Blue" } }],
    });
    expect(parseDataType(color + color).diagnostics[0]).toMatchObject({ pou: "Color" });
    for (const source of ["TYPE X : INT;", "TYPE X : @; END_TYPE"])
      expect(parseDataType(source).diagnostics[0]).toMatchObject({ pou: "X" });
  });
  it("keeps the type table in source order and resolves case-insensitive forward aliases", () => {
    const result = compile("v : speed;", "", [
      "TYPE Speed : Base := 100; END_TYPE",
      "TYPE Base : INT; END_TYPE",
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.types?.map((entry) => entry.name)).toEqual(["Speed", "Base"]);
    expect(result.ir?.variables[0]).toMatchObject({
      dataType: { kind: "named", name: "Speed" },
      initialValue: 100,
    });
    expect(JSON.parse(JSON.stringify(result.ir))).toEqual(result.ir);
  });
  it.each([
    [[color, "TYPE COLOR : INT; END_TYPE"], "decl.duplicate", "COLOR"],
    [["TYPE Main : INT; END_TYPE"], "decl.name-collision", "Main"],
    [["TYPE TON : INT; END_TYPE"], "decl.name-collision", "TON"],
    [["TYPE ABS : INT; END_TYPE"], "decl.name-collision", "ABS"],
    [["TYPE INT : INT; END_TYPE"], "decl.name-collision", "INT"],
    [["TYPE X : Unknown; END_TYPE"], "decl.unknown-type", "X"],
  ])("reports source identity for namespace errors %j", (types, code, pou) => {
    const result = compile("", "", types);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code, pou, sourceKind: "dataType", sourceIndex: types.length - 1 }),
    );
  });
  it("rejects unknown variable and result types with POU identity and cyclic aliases", () => {
    expect(compile("x : Unknown;").diagnostics).toContainEqual(
      expect.objectContaining({ code: "decl.unknown-type", pou: "Main", sourceIndex: 0 }),
    );
    expect(compile("", "", [], ["FUNCTION F : Unknown END_FUNCTION"]).diagnostics).toContainEqual(
      expect.objectContaining({ code: "decl.unknown-type", pou: "F", sourceIndex: 1 }),
    );
    expect(compile("", "", ["TYPE A : B; END_TYPE", "TYPE B : A; END_TYPE"]).ir).toBeUndefined();
  });
  it("treats aliases and CONSTANT aliases as their elementary base", () => {
    const result = compileProject(
      [
        `PROGRAM Main VAR CONSTANT MaxSpeed : Speed; END_VAR VAR v : INT := MaxSpeed; END_VAR v := v + MaxSpeed; END_PROGRAM`,
      ],
      ["TYPE Speed : INT := 100; END_TYPE"],
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.variables).toHaveLength(1);
    expect(result.ir?.variables[0]).toMatchObject({ initialValue: 100 });
  });
});

describe("enumerations", () => {
  it("resolves qualified and contextual values with declared defaults and explicit base values", () => {
    const result = compile(
      "x : Color; y : Mode; same : BOOL;",
      "x := gReEn; same := Red = x; same := x <> Color#Blue;",
      [color, "TYPE Mode : DINT (Off := -1, Auto := 10, Manual); END_TYPE"],
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.types?.[1]).toMatchObject({
      definition: { base: "DINT", values: [{ value: -1 }, { value: 10 }, { value: 11 }] },
    });
    expect(result.ir?.variables.map((variable) => variable.initialValue)).toEqual([0, -1, false]);
  });
  it("supports an explicit default, aliases and CONSTANT enumerations", () => {
    const result = compileProject(
      [
        `PROGRAM Main VAR CONSTANT Favorite : Color := Blue; END_VAR VAR a : Color; b : Hue := Favorite; END_VAR a := b; END_PROGRAM`,
      ],
      ["TYPE Color : (Red, Green, Blue) := Green; END_TYPE", "TYPE Hue : Color; END_TYPE"],
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.variables.map((variable) => variable.initialValue)).toEqual([1, 2]);
  });
  it.each([
    "x := Color#Red + 1;",
    "x := -x;",
    "same := x < Color#Blue;",
    "x := 1;",
    "i := x;",
    "x := Other#Red;",
    "i := INT_TO_DINT(x);",
    "same := EQ(x, x);",
    "x := MIN(x, x);",
    "x := SEL(TRUE, x, Other#Red);",
    "CASE x OF 0: x := Red; END_CASE;",
    "CASE x OF Red..Blue: x := Red; END_CASE;",
    "FOR i := x TO 3 DO END_FOR;",
    "FOR x := Red TO Blue DO END_FOR;",
  ])("rejects invalid enum use: %s", (body) => {
    expect(
      compile("x : Color; same : BOOL; i : DINT;", body, [
        color,
        "TYPE Other : (Red, Blue); END_TYPE",
      ]).ir,
    ).toBeUndefined();
  });
  it.each([
    "x := SEL(TRUE, Red, Blue);",
    "x := MUX(0, Red, Green, Blue);",
    "x := MOVE(Blue);",
    "x := SEL(TRUE, Color#Red, Blue);",
    "x := SEL(TRUE, MOVE(Red), Blue);",
  ])("supports same-type selection %s", (body) => {
    expect(compile("x : Color;", body).diagnostics).toEqual([]);
  });
  it("rejects numeric enumeration defaults", () => {
    expect(codes(compile("", "", ["TYPE E : (A, B) := 2; END_TYPE"]))).toContain(
      "type.assign-mismatch",
    );
  });
  it("rejects elementary standard-function outputs assigned to an enumeration", () => {
    const result = compile("x : Color;", "SPLIT_DATE(IN := D#2026-10-23, YEAR => x);");
    expect(codes(result)).toContain("type.assign-mismatch");
    expect(result.ir).toBeUndefined();
  });
  it("rejects ambiguous and uncontextual names", () => {
    expect(codes(compile("x : Color; Red : INT;", "x := Red;"))).toContain(
      "type.ambiguous-enumeration",
    );
    expect(codes(compile("x : Color;", "x := MOVE(Red) + 1;"))).toContain("name.undeclared");
    expect(compile("x : Color; Red : INT;", "x := Color#Red;").diagnostics).toEqual([]);
  });
  it.each([
    "TYPE E : (A := 1, B := 1); END_TYPE",
    "TYPE E : (A, a); END_TYPE",
    "TYPE E : SINT (A := 127, B); END_TYPE",
    "TYPE E : (A := 32768); END_TYPE",
    "TYPE E : REAL (A); END_TYPE",
  ])("rejects invalid enumeration declaration %s", (source) => {
    expect(codes(compile("", "", [source]))).toContain("type.invalid-constant");
  });
});

describe("subranges", () => {
  it("accepts identifier-led constant expressions as named bounds", () => {
    const result = compile("p : Percent;", "", [
      "TYPE Percent : INT (DINT_TO_INT(0)..DINT_TO_INT(100)); END_TYPE",
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.types?.[0]).toMatchObject({
      definition: { kind: "subrange", base: "INT", lower: 0, upper: 100 },
    });
  });
  it("defaults named and inline ranges to their lower bound, honors explicit defaults and has no inline table entry", () => {
    const result = compile("a : Offset; b : INT (-3..3); c : Percent;", "", [
      "TYPE Offset : INT (-10..10); END_TYPE",
      "TYPE Percent : INT (0..100) := 50; END_TYPE",
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.types).toHaveLength(2);
    expect(result.ir?.variables.map((variable) => variable.initialValue)).toEqual([-10, -3, 50]);
    expect(result.ir?.variables[1]).toMatchObject({
      dataType: { kind: "subrange", base: "INT", lower: -3, upper: 3 },
    });
  });
  it.each(["p : Percent := 120;", "p : INT (0..100) := -1;"])(
    "rejects out-of-range initializers %s",
    (declarations) => {
      expect(codes(compile(declarations))).toContain("type.invalid-constant");
    },
  );
  it("checks constant stores but uses base typing for arithmetic and generic functions", () => {
    expect(codes(compile("p : Percent;", "p := 120;"))).toContain("type.invalid-constant");
    expect(
      compile("p : Percent; i : INT;", "i := ABS(p) + p; p := SEL(TRUE, p, i);").diagnostics,
    ).toEqual([]);
  });
  it.each([
    "TYPE P : REAL (0..1); END_TYPE",
    "TYPE P : INT (10..0); END_TYPE",
    "TYPE P : USINT (-1..10); END_TYPE",
    "TYPE P : INT (0..100) := 120; END_TYPE",
  ])("rejects invalid subrange %s", (source) => {
    expect(compile("", "", [source]).ir).toBeUndefined();
  });
  it("resolves inline bounds from earlier constants in the declaring POU, including parameter signatures", () => {
    const result = compileProject([
      `PROGRAM Main VAR CONSTANT N : INT := 10; END_VAR VAR p : INT (-N..N); END_VAR F(x := p); END_PROGRAM`,
      `FUNCTION F VAR CONSTANT Bound : INT := 10; END_VAR VAR_IN_OUT x : INT (-Bound..Bound); END_VAR x := Bound; END_FUNCTION`,
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.variables[0]).toMatchObject({
      dataType: { kind: "subrange", lower: -10, upper: 10 },
      initialValue: -10,
    });
  });
  it("rejects subrange FOR controls", () => {
    expect(codes(compile("p : Percent;", "FOR p := 0 TO 10 DO END_FOR;"))).toContain(
      "type.for-variable-not-integer",
    );
  });
  it("uses structural exact matching for in-outs", () => {
    const fn = (type: string) => `FUNCTION F VAR_IN_OUT x : ${type}; END_VAR END_FUNCTION`;
    expect(codes(compile("p : Percent;", "F(x := p);", [percent], [fn("INT")]))).toContain(
      "call.in-out-type",
    );
    expect(
      compile("p : Percent;", "F(x := p);", [percent], [fn("INT (0..100)")]).diagnostics,
    ).toEqual([]);
    expect(codes(compile("p : Percent;", "F(x := p);", [percent], [fn("INT (0..99)")]))).toContain(
      "call.in-out-type",
    );
  });
});

it("does not suggest forbidden enum conversions for assignment errors", () => {
  const result = compile("x : Color; target : DINT;", "target := x;");
  const diagnostic = result.diagnostics.find(
    (diagnostic) => diagnostic.code === "type.assign-mismatch",
  );
  expect(diagnostic?.args).toEqual({ from: { kind: "named", name: "Color" }, to: "DINT" });
});

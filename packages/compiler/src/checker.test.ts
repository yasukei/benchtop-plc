import { describe, expect, it } from "vitest";
import type { DiagnosticCode } from "@benchtop-plc/core";
import { check, parse } from "./index.js";

function program(declarations: string, body = "") {
  const parsed = parse(`PROGRAM P\nVAR\n${declarations}\nEND_VAR\n${body}\nEND_PROGRAM`);
  expect(parsed.diagnostics).toEqual([]);
  return parsed.ast!;
}

function valid(declarations: string, body = "") {
  const ast = program(declarations, body);
  const result = check(ast);
  expect(result.diagnostics).toEqual([]);
  expect(result.checked).not.toBeNull();
  return result.checked!;
}

/** Mark the complete expected offending construct, including its exclusive end. */
function failure(declarations: string, body: string, code: DiagnosticCode) {
  const marked = `PROGRAM P\nVAR\n${declarations}\nEND_VAR\n${body}\nEND_PROGRAM`;
  const start = marked.indexOf("«"),
    end = marked.indexOf("»");
  expect(start).toBeGreaterThan(-1);
  const source = marked.replace("«", "").replace("»", "");
  const position = (offset: number) => {
    const lines = source.slice(0, offset).split("\n");
    return { line: lines.length, column: lines.at(-1)!.length + 1 };
  };
  const first = position(start),
    last = position(end - 1);
  const parsed = parse(source);
  expect(parsed.diagnostics).toEqual([]);
  const result = check(parsed.ast!);
  expect(result.checked).toBeNull();
  expect(result.diagnostics).toContainEqual({
    code,
    severity: "error",
    args: expect.any(Object),
    span: { ...first, endLine: last.line, endColumn: last.column },
  });
  return result.diagnostics.find((diagnostic) => diagnostic.code === code)!;
}

describe("declarations and symbols", () => {
  it("normalizes names across VAR blocks and retains spelling and declaration order", () => {
    const ast = parse(
      "PROGRAM P VAR Counter : INT; END_VAR VAR b : BOOL; END_VAR cOuNtEr := 1; END_PROGRAM",
    ).ast!;
    const result = check(ast);
    expect(result.diagnostics).toEqual([]);
    expect(
      result.checked!.symbols.map(({ id, name, type, initialValue }) => [
        id,
        name.name,
        type,
        initialValue,
      ]),
    ).toEqual([
      [0, "Counter", "INT", 0],
      [1, "b", "BOOL", false],
    ]);
    const assignment = ast.body[0]!;
    if (assignment.kind !== "assignment" || assignment.target.kind !== "name")
      throw new Error("assignment expected");
    expect(result.checked!.references.get(assignment.target.name)).toEqual({ variable: 0 });
  });

  it.each([
    ["x : INT; «X» : BOOL;", "decl.duplicate"],
    ["x : UnknownType; «X» : BOOL;", "decl.duplicate"],
    ["«tOn» : INT;", "decl.name-collision"],
    ["«aBs» : INT;", "decl.name-collision"],
    ["x : «CustomType»;", "decl.unknown-type"],
    ["x AT «%IX0.0» : INT;", "decl.direct-address-type"],
    ["x AT «%QX0.0» : TON;", "decl.direct-address-type"],
    ["x,y AT «%IX0.0» : BOOL;", "decl.at-multiple-names"],
    ["x AT «%IX1.0» : BOOL;", "decl.address-out-of-range"],
    ["x AT «%QX0.8» : BOOL;", "decl.address-out-of-range"],
    ["x : INT; y : INT := «x»;", "decl.nonconstant-initializer"],
    ["x : INT := «ABS(1)»;", "decl.nonconstant-initializer"],
    ["t : TON := «0»;", "decl.fb-initializer"],
    ["x : BOOL := «1»;", "type.assign-mismatch"],
    ["x : INT := «1.5»;", "type.assign-mismatch"],
    ["x : REAL := «T#1s»;", "type.assign-mismatch"],
    ["x : TIME := «1»;", "type.assign-mismatch"],
    ["x : INT := «1 / 0»;", "type.invalid-constant"],
    ["x : REAL := «1.0e100»;", "type.invalid-constant"],
  ] as const)("reports declaration rule in %s", (declarations, code) => {
    failure(declarations, "", code);
  });

  it("accepts every elementary and FB type and all supported addresses", () => {
    const types = [
      "BOOL",
      "INT",
      "UINT",
      "DINT",
      "REAL",
      "LREAL",
      "TIME",
      "TON",
      "TOF",
      "TP",
      "R_TRIG",
      "F_TRIG",
      "CTU",
      "CTD",
    ];
    const declarations = types.map((type, index) => `v${index} : ${type};`);
    for (const area of ["I", "Q"])
      for (let bit = 0; bit < 8; bit++)
        declarations.push(`${area}${bit} AT %${area}X0.${bit} : BOOL;`);
    expect(valid(declarations.join("\n")).symbols).toHaveLength(30);
  });

  it("checks literals, groups and constant operators with PLC coercion", () => {
    const checked = valid(
      "a,b : INT := (7 / -2) + 1; c : UINT := -1; d : BOOL := NOT FALSE AND TRUE; e : TIME := (T#1s + T#500ms) / 2; f : REAL := 1 + 1.5; g : DINT := 40000; h : INT := 5 MOD 2; i : INT := NOT 0; j : BOOL := (2 < 3) XOR (1 = 2);",
    );
    expect(checked.symbols.map((symbol) => symbol.initialValue)).toEqual([
      -2,
      -2,
      65535,
      true,
      750,
      2.5,
      40000,
      1,
      -1,
      true,
    ]);
  });

  it("rejects elementary type collisions even for an AST provided directly", () => {
    const ast = program("x : INT;");
    ast.declarations[0]!.names[0].name = "iNt";
    ast.declarations[0]!.names[0].key = "INT";
    expect(check(ast).diagnostics).toEqual([
      {
        code: "decl.name-collision",
        severity: "error",
        span: ast.declarations[0]!.names[0].span,
        args: { name: "iNt", kind: "type" },
      },
    ]);
  });

  it("does not mutate or retain state between checks", () => {
    const ast = program("x : INT := 1 + 2;", "x := x + 1;");
    const snapshot = JSON.stringify(ast);
    expect(check(ast).diagnostics).toEqual([]);
    expect(check(ast).checked!.symbols).toHaveLength(1);
    expect(JSON.stringify(ast)).toBe(snapshot);
  });
});

describe("assignments and operands", () => {
  it.each([
    ["BOOL", "BOOL"],
    ["INT", "UINT"],
    ["UINT", "DINT"],
    ["DINT", "INT"],
    ["REAL", "DINT"],
    ["REAL", "LREAL"],
    ["LREAL", "REAL"],
    ["TIME", "TIME"],
  ])("assigns %s from %s", (to, from) => {
    valid(`a : ${to}; b : ${from};`, "a := b;");
  });

  it.each([
    ["BOOL", "INT"],
    ["INT", "BOOL"],
    ["INT", "REAL"],
    ["UINT", "LREAL"],
    ["DINT", "TIME"],
    ["REAL", "BOOL"],
    ["LREAL", "TIME"],
    ["TIME", "DINT"],
  ])("rejects assigning %s from %s", (to, from) => {
    expect(
      failure(`a : ${to}; b : ${from};`, "a := «b»;", "type.assign-mismatch").args,
    ).toMatchObject({ to, from });
  });

  it("supplies a localizable explicit-conversion hint for real to integer", () => {
    expect(failure("a : INT;", "a := «1.5»;", "type.assign-mismatch").args).toEqual({
      from: "REAL",
      to: "INT",
      hint: "explicit-conversion",
    });
  });

  it.each([
    ["a + b", "INT", "UINT", "INT"],
    ["a - b", "DINT", "INT", "DINT"],
    ["a + b", "LREAL", "INT", "REAL"],
    ["a * b", "UINT", "REAL", "REAL"],
    ["a / b", "INT", "INT", "INT"],
    ["a MOD b", "DINT", "UINT", "DINT"],
    ["a + b", "TIME", "TIME", "TIME"],
    ["a - b", "TIME", "TIME", "TIME"],
    ["a * b", "TIME", "INT", "TIME"],
    ["a / b", "TIME", "REAL", "TIME"],
    ["a AND b", "BOOL", "BOOL", "BOOL"],
    ["a & b", "INT", "DINT", "DINT"],
    ["a OR b", "UINT", "INT", "INT"],
    ["a XOR b", "BOOL", "BOOL", "BOOL"],
    ["a = b", "BOOL", "BOOL", "BOOL"],
    ["a <> b", "INT", "REAL", "BOOL"],
    ["a < b", "TIME", "TIME", "BOOL"],
    ["a > b", "LREAL", "UINT", "BOOL"],
    ["a <= b", "INT", "DINT", "BOOL"],
    ["a >= b", "TIME", "TIME", "BOOL"],
  ])("types %s with %s and %s as %s", (expression, left, right, expected) => {
    const checked = valid(`a : ${left}; b : ${right}; c : ${expected};`, `c := ${expression};`);
    const statement = checked.ast.body[0]!;
    if (statement.kind !== "assignment") throw new Error("assignment expected");
    expect(checked.expressions.get(statement.value)?.dataType).toBe(expected);
  });

  it.each([
    ["+", "BOOL", "INT"],
    ["-", "TIME", "INT"],
    ["*", "INT", "TIME"],
    ["/", "TIME", "TIME"],
    ["MOD", "REAL", "INT"],
    ["AND", "BOOL", "INT"],
    ["&", "REAL", "REAL"],
    ["OR", "TIME", "TIME"],
    ["XOR", "BOOL", "REAL"],
    ["=", "TIME", "INT"],
    ["<>", "BOOL", "INT"],
    ["<", "BOOL", "BOOL"],
    [">", "TIME", "INT"],
    ["<=", "REAL", "BOOL"],
    [">=", "TIME", "REAL"],
  ])("rejects %s with %s and %s", (operator, left, right) => {
    failure(
      `a : ${left}; b : ${right}; c : INT;`,
      `c := «a ${operator} b»;`,
      "type.operand-mismatch",
    );
  });

  it.each([
    ["NOT", "BOOL"],
    ["NOT", "INT"],
    ["NOT", "UINT"],
    ["NOT", "DINT"],
    ["-", "REAL"],
    ["+", "LREAL"],
    ["-", "TIME"],
  ])("accepts unary %s %s", (operator, type) => {
    valid(`a,b : ${type};`, `a := ${operator} b;`);
  });
  it.each([
    ["NOT", "REAL"],
    ["NOT", "TIME"],
    ["-", "BOOL"],
    ["+", "BOOL"],
  ])("rejects unary %s %s", (operator, type) => {
    expect(
      failure(`a,b : ${type};`, `a := «${operator} b»;`, "type.operand-mismatch").args,
    ).toMatchObject({ operator, left: type, right: null });
  });
  it("reports undeclared references and assignment targets", () => {
    failure("a : INT;", "a := «missing»;", "name.undeclared");
    failure("a : INT;", "«missing» := a;", "name.undeclared");
  });
});

describe("control flow", () => {
  it("accepts nested statements, integer labels, bounds and loop-scoped EXIT", () => {
    valid(
      "i : INT; u : UINT; d : DINT; b : BOOL;",
      "IF b THEN RETURN; ELSIF NOT b THEN i := 2; ELSE i := 3; END_IF; CASE i OF 1, 2..4: i := 0; -1: i := 1; ELSE i := 2; END_CASE; FOR u := i TO d BY -1 DO IF b THEN EXIT; END_IF; END_FOR; WHILE b DO EXIT; END_WHILE; REPEAT EXIT; UNTIL b END_REPEAT;",
    );
  });
  it.each([
    ["IF «1» THEN END_IF;", "type.condition-not-bool"],
    ["IF TRUE THEN ELSIF «1» THEN END_IF;", "type.condition-not-bool"],
    ["WHILE «1» DO END_WHILE;", "type.condition-not-bool"],
    ["REPEAT UNTIL «1» END_REPEAT;", "type.condition-not-bool"],
    ["CASE «TRUE» OF 1: END_CASE;", "type.case-selector-not-integer"],
    ["CASE i OF «TRUE»: END_CASE;", "type.case-label-not-integer"],
    ["CASE i OF 1..«1.5»: END_CASE;", "type.case-label-not-integer"],
    ["CASE i OF «1.5»..2: END_CASE;", "type.case-label-not-integer"],
    ["CASE i OF «i»: END_CASE;", "type.case-label-not-constant"],
    ["FOR «b» := 1 TO 2 DO END_FOR;", "type.for-variable-not-integer"],
    ["FOR i := «1.5» TO 2 DO END_FOR;", "type.for-bound-not-integer"],
    ["FOR i := 1 TO «T#2s» DO END_FOR;", "type.for-bound-not-integer"],
    ["FOR i := 1 TO 2 BY «TRUE» DO END_FOR;", "type.for-bound-not-integer"],
    ["«EXIT;»", "flow.exit-outside-loop"],
    ["WHILE TRUE DO EXIT; END_WHILE; IF TRUE THEN «EXIT;» END_IF;", "flow.exit-outside-loop"],
    ["FOR «t» := 1 TO 2 DO END_FOR;", "fb.instance-as-value"],
    ["FOR «unknown» := 1 TO 2 DO END_FOR;", "name.undeclared"],
  ] as const)("diagnoses %s", (body, code) => {
    failure("i : INT; b : BOOL; t : TON;", body, code);
  });
});

describe("function blocks", () => {
  it("resolves input/output members and named inputs case insensitively", () => {
    const checked = valid(
      "timer : TON; b : BOOL; elapsed : TIME;",
      "timer.in := b; b := timer.IN; b := timer.q; elapsed := timer.et; timer(pt := T#1s, In := b); timer();",
    );
    const call = checked.ast.body[4]!;
    if (call.kind !== "fbCall") throw new Error("call expected");
    expect(checked.references.get(call.instance)).toEqual({ variable: 0 });
    expect(checked.references.get(call.inputs[0]!.name)).toEqual({
      variable: 0,
      port: "input",
      member: 1,
    });
  });
  it("accepts every block signature", () => {
    valid(
      "a : TON; b : TOF; c : TP; d : R_TRIG; e : F_TRIG; f : CTU; g : CTD;",
      "a(IN := TRUE, PT := T#1s); b(IN := FALSE, PT := T#0ms); c(IN := TRUE, PT := T#1s); d(CLK := TRUE); e(CLK := FALSE); f(CU := TRUE, R := FALSE, PV := 10); g(CD := TRUE, LD := FALSE, PV := 10);",
    );
  });
  it.each([
    ["b := «timer»;", "fb.instance-as-value"],
    ["b := «timer()»;", "fb.call-in-expression"],
    ["timer.«Q» := b;", "fb.output-not-writable"],
    ["timer(«Q» := b);", "fb.output-not-writable"],
    ["timer.«unknown» := b;", "fb.unknown-member"],
    ["timer(«unknown» := b);", "fb.unknown-member"],
    ["timer(IN := «1»);", "type.assign-mismatch"],
    ["timer(IN := TRUE, «in» := FALSE);", "fb.duplicate-input"],
    ["«b»();", "fb.not-function-block"],
    ["b := «b».Q;", "fb.not-function-block"],
    ["«missing»();", "name.undeclared"],
    ["b := «missing».Q;", "name.undeclared"],
  ] as const)("diagnoses %s", (body, code) => {
    failure("timer : TON; b : BOOL;", body, code);
  });
});

describe("standard functions", () => {
  it.each([
    ["ABS(-1)", "INT"],
    ["abs(1.5)", "REAL"],
    ["MIN(1,2)", "INT"],
    ["MAX(1,2,3,4.5)", "REAL"],
    ["LIMIT(0,1,2)", "INT"],
    ["SEL(TRUE,1,2.5)", "REAL"],
    ["SEL(FALSE,TRUE,FALSE)", "BOOL"],
    ["SEL(TRUE,T#1s,T#2s)", "TIME"],
    ["REAL_TO_INT(1.5)", "INT"],
    ["INT_TO_REAL(1)", "REAL"],
    ["TIME_TO_INT(T#1s)", "INT"],
    ["INT_TO_TIME(1)", "TIME"],
    ["BOOL_TO_INT(TRUE)", "INT"],
  ])("accepts %s", (expression, type) => {
    valid(`x : ${type};`, `x := ${expression};`);
  });

  it.each([
    "ABS()",
    "ABS(1,2)",
    "MIN(1)",
    "MAX()",
    "LIMIT(1,2)",
    "LIMIT(1,2,3,4)",
    "SEL(TRUE,1)",
    "REAL_TO_INT()",
    "INT_TO_REAL(1,2)",
    "TIME_TO_INT()",
    "INT_TO_TIME()",
    "BOOL_TO_INT()",
  ])("checks argument count for %s", (expression) => {
    failure("x : INT;", `x := «${expression}»;`, "call.argument-count");
  });

  it.each([
    "ABS(«TRUE»)",
    "MIN(1,«T#1s»)",
    "MAX(«FALSE»,1)",
    "LIMIT(0,«FALSE»,1)",
    "SEL(«1»,1,2)",
    "SEL(TRUE,«FALSE»,1)",
    "REAL_TO_INT(«1»)",
    "INT_TO_REAL(«TRUE»)",
    "TIME_TO_INT(«1»)",
    "INT_TO_TIME(«T#1s»)",
    "BOOL_TO_INT(«1»)",
  ])("checks argument types for %s", (expression) => {
    failure("x : INT;", `x := ${expression};`, "call.argument-type");
  });

  it("reports unknown functions at the name", () => {
    failure("x : INT;", "x := «unknown»(1);", "call.unknown-function");
  });
});

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
    ["x : DINT := «ABS(1)»;", "decl.nonconstant-initializer"],
    ["t : TON := «0»;", "decl.fb-initializer"],
    ["x : BOOL := «2»;", "type.invalid-constant"],
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
      "a,b : INT := (7 / -2) + 1; c : UINT := UINT#0 - UINT#1; d : BOOL := NOT FALSE AND TRUE; e : TIME := (T#1s + T#500ms) / 2; f : REAL := 1 + 1.5; g : DINT := 40000; h : INT := 5 MOD 2; i : WORD := NOT WORD#0; j : BOOL := (2 < 3) XOR (1 = 2);",
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
      65535,
      true,
    ]);
  });

  it.each([
    ["0.1", 0.1],
    ["(0.1)", 0.1],
    ["-0.1", -0.1],
    ["+0.1", 0.1],
    ["1.0e100", 1e100],
    ["-(1.0e100)", -1e100],
  ])("preserves binary64 precision for LREAL initializer %s", (source, expected) => {
    expect(valid(`x : LREAL := ${source};`).symbols[0]!.initialValue).toBe(expected);
  });

  it("rounds REAL destinations and arithmetic results to binary32", () => {
    const checked = valid(
      "a : REAL := 0.1; b : LREAL := REAL#0.1 + REAL#0.0; c : INT := DINT_TO_INT(40000); d : DINT := DINT#2147483647 + DINT#1;",
    );
    expect(checked.symbols.map((symbol) => symbol.initialValue)).toEqual([
      Math.fround(0.1),
      Math.fround(0.1),
      -25536,
      -2147483648,
    ]);
    failure("x : REAL := «-1.0e100»;", "", "type.invalid-constant");
    failure("x : REAL;", "x := «1.0e100»;", "type.invalid-constant");
    valid("x : LREAL;", "x := 1.0e100;");
    valid("x : LREAL := 1.0e100 + 0.0;");
    failure("x : LREAL := «REAL#3e38 * REAL#2.0»;", "", "type.invalid-constant");
  });

  it("checks an untyped integer against its destination", () => {
    for (const text of ["3000000000", "2147483648", "-2147483649"])
      failure(`x : DINT := «${text}»;`, "", "type.invalid-constant");
    valid("x : REAL := 3000000000; y : LREAL := 2147483648;");
  });

  it.each([
    ["32767", "DINT", 32767],
    ["32768", "DINT", 32768],
    ["2147483647", "DINT", 2147483647],
    ["-2147483648", "DINT", -2147483648],
    ["-(2147483648)", "DINT", -2147483648],
    ["-16#8000_0000", "DINT", -2147483648],
  ] as const)("accepts integer boundary %s as %s", (source, expectedType, value) => {
    const checked = valid(`x : DINT := ${source};`);
    expect(checked.symbols[0]!.initialValue).toBe(value);
    const initializer = checked.ast.declarations[0]!.initializer!;
    expect(checked.expressions.get(initializer)).toMatchObject({
      dataType: expectedType,
      constant: value,
    });
  });

  it("checks complete untyped expressions before typing", () => {
    failure("x : DINT := «+2147483648»;", "", "type.invalid-constant");
    valid("x : DINT := -(2147483648 + 0);");
    failure("x : DINT := «16#FFFF_FFFF»;", "", "type.invalid-constant");
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
    ["DINT", "UINT"],
    ["REAL", "UINT"],
    ["DINT", "INT"],
    ["LREAL", "DINT"],
    ["LREAL", "LREAL"],
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
      from: "LREAL",
      to: "INT",
      hint: "explicit-conversion",
    });
  });

  it.each([
    ["a + b", "INT", "UINT", "DINT"],
    ["a - b", "DINT", "INT", "DINT"],
    ["a + b", "LREAL", "INT", "LREAL"],
    ["a * b", "UINT", "REAL", "REAL"],
    ["a / b", "INT", "INT", "INT"],
    ["a MOD b", "DINT", "UINT", "DINT"],
    ["a + b", "TIME", "TIME", "TIME"],
    ["a - b", "TIME", "TIME", "TIME"],
    ["a * b", "TIME", "INT", "TIME"],
    ["a / b", "TIME", "REAL", "TIME"],
    ["a AND b", "BOOL", "BOOL", "BOOL"],
    ["a & b", "BYTE", "DWORD", "DWORD"],
    ["a OR b", "BOOL", "WORD", "WORD"],
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
    ["<", "BOOL", "TIME"],
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
    ["NOT", "BYTE"],
    ["NOT", "WORD"],
    ["NOT", "DWORD"],
    ["-", "REAL"],
    ["+", "LREAL"],
    ["-", "TIME"],
  ])("accepts unary %s %s", (operator, type) => {
    valid(`a,b : ${type};`, `a := ${operator} b;`);
  });
  it.each([
    ["NOT", "INT"],
    ["NOT", "UINT"],
    ["NOT", "DINT"],
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
      "IF b THEN RETURN; ELSIF NOT b THEN i := 2; ELSE i := 3; END_IF; CASE i OF 1, 2..4: i := 0; -1: i := 1; ELSE i := 2; END_CASE; FOR i := 3 TO DINT_TO_INT(d) BY -1 DO IF b THEN EXIT; END_IF; END_FOR; WHILE b DO EXIT; END_WHILE; REPEAT EXIT; UNTIL b END_REPEAT;",
    );
  });
  it.each([
    ["IF «2» THEN END_IF;", "type.invalid-constant"],
    ["IF TRUE THEN ELSIF «2» THEN END_IF;", "type.invalid-constant"],
    ["WHILE «2» DO END_WHILE;", "type.invalid-constant"],
    ["REPEAT UNTIL «2» END_REPEAT;", "type.invalid-constant"],
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
    ["timer(IN := «2»);", "type.invalid-constant"],
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
    ["ABS(-1)", "DINT"],
    ["abs(1.5)", "LREAL"],
    ["MIN(1,2)", "DINT"],
    ["MAX(1,2,3,4.5)", "LREAL"],
    ["LIMIT(0,1,2)", "DINT"],
    ["SEL(TRUE,1,2.5)", "LREAL"],
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
    "MAX(FALSE,«INT#1»)",
    "LIMIT(T#0s,«FALSE»,T#1s)",
    "SEL(«T#1s»,1,2)",
    "SEL(TRUE,FALSE,«T#1s»)",
    "REAL_TO_INT(«TRUE»)",
    "INT_TO_REAL(«TRUE»)",
    "TIME_TO_INT(«1»)",
    "INT_TO_TIME(«T#1s»)",
    "BOOL_TO_INT(«T#1s»)",
  ])("checks argument types for %s", (expression) => {
    failure("x : INT;", `x := ${expression};`, "call.argument-type");
  });

  it.each([
    ["MUX(0, 1, 2, «T#1s»)", "MUX", 3, "DINT", "TIME"],
    ["GT(1, 2, «T#1s»)", "GT", 2, "DINT", "TIME"],
    ["LIMIT(T#0s, «FALSE», T#1s)", "LIMIT", 1, "TIME", "BOOL"],
    ["SEL(TRUE, FALSE, «T#1s»)", "SEL", 2, "BOOL", "TIME"],
    ["MAX(INT#1, UINT#2, REAL#3, «T#1s»)", "MAX", 3, "REAL", "TIME"],
    ["MUX(0, missing, 1, «T#1s»)", "MUX", 3, "DINT", "TIME"],
  ])(
    "identifies the incompatible generic argument in %s",
    (expression, name, index, expected, found) => {
      const diagnostic = failure("x: DINT;", `x := ${expression};`, "call.argument-type");
      expect(diagnostic.args).toEqual({ name, index, expected: [expected], found });
    },
  );

  it("reports unknown functions at the name", () => {
    failure("x : INT;", "x := «unknown»(1);", "call.unknown-function");
  });
});

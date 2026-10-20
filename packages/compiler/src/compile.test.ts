import { describe, expect, it } from "vitest";
import type { Expression, ProgramIR } from "@benchtop-plc/core";
import { check, compile, lower, parse } from "./index.js";

function valid(declarations: string, body = ""): ProgramIR {
  const result = compile(`PROGRAM Main\nVAR\n${declarations}\nEND_VAR\n${body}\nEND_PROGRAM`);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir).toBeDefined();
  return result.ir!;
}

function values(ir: ProgramIR): Expression[] {
  return ir.body.map((node) => {
    if (node.kind !== "assignment") throw new Error("Expected assignment");
    return node.value;
  });
}

describe("compile entry point", () => {
  it("omits IR and preserves lexer, parser and checker diagnostics", () => {
    for (const source of [
      "PROGRAM P @ END_PROGRAM",
      "PROGRAM P VAR x : INT END_VAR END_PROGRAM",
      "PROGRAM P VAR x : BOOL; END_VAR x := 2; END_PROGRAM",
      "PROGRAM P missing := 1; END_PROGRAM",
    ]) {
      const parsed = parse(source);
      const expected = parsed.ast ? check(parsed.ast).diagnostics : parsed.diagnostics;
      const result = compile(source);
      expect(result).not.toHaveProperty("ir");
      expect(result.diagnostics).toEqual(expected);
      expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it("supports empty programs and independent repeated compilations", () => {
    const source = "PROGRAM Empty END_PROGRAM";
    expect(compile(source)).toMatchObject({
      ir: { name: "Empty", variables: [], body: [] },
      diagnostics: [],
    });
    compile("invalid");
    expect(compile(source)).toStrictEqual(compile(source));
  });

  it("lowers without modifying or retaining mutable AST objects", () => {
    const ast = parse("PROGRAM P VAR x : INT; END_VAR x := (1 + 2); END_PROGRAM").ast!;
    const before: unknown = JSON.parse(JSON.stringify(ast));
    const checked = check(ast).checked!;
    const ir = lower(checked);
    expect(ast).toStrictEqual(before);
    const again = lower(checked);
    expect(ir).toStrictEqual(again);
    ir.span.line = 99;
    ir.variables[0]!.span.line = 99;
    ir.body[0]!.span.line = 99;
    expect(ast).toStrictEqual(before);
    expect(lower(checked)).toStrictEqual(again);
  });

  it("keeps enormous TIME literals JSON-safe while checking their exact text", () => {
    const source = `PROGRAM P VAR x : TIME := T#${"9".repeat(309)}ms; END_VAR END_PROGRAM`;
    const parsed = parse(source);
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.ast).not.toBeNull();
    const restored = JSON.parse(JSON.stringify(parsed.ast));
    expect(restored).toStrictEqual(parsed.ast);
    expect(check(restored).diagnostics).toMatchObject([{ code: "type.invalid-constant" }]);
    expect(compile(source).diagnostics).toMatchObject([{ code: "type.invalid-constant" }]);
  });
});

describe("declarations and resolved expressions", () => {
  it.each([
    ["INT", 7],
    ["INT", -7],
    ["DINT", 40000],
    ["DINT", -40000],
    ["UINT", 7],
  ] as const)("initializes %s from %s MOD 0 without diagnostics", (type, dividend) => {
    const ir = valid(`x : ${type} := ${dividend} MOD 0;`);
    expect(ir.variables[0]).toMatchObject({ kind: "scalar", dataType: type, initialValue: 0 });
  });

  it("retains declaration order, spelling, defaults, coerced initializers and BOOL addresses", () => {
    const ir = valid(`a, B : INT := INT#32767 + INT#1;
u : UINT := INT_TO_UINT(-1);
d : DINT;
r : REAL := 0.1;
l : LREAL := 0.1;
t : TIME := T#1s500ms;
flag AT %IX0.7 : BOOL;
out AT %QX0.0 : BOOL := TRUE;
timer : tOn;`);
    expect(ir.variables.map((node) => [node.name, node.key, node.initialValue])).toEqual([
      ["a", "A", -32768],
      ["B", "B", -32768],
      ["u", "U", 65535],
      ["d", "D", 0],
      ["r", "R", Math.fround(0.1)],
      ["l", "L", 0.1],
      ["t", "T", 1500],
      ["flag", "FLAG", false],
      ["out", "OUT", true],
      ["timer", "TIMER", null],
    ]);
    expect(ir.variables[0]!.span).toEqual(ir.variables[1]!.span);
    expect(ir.variables[7]).toMatchObject({
      dataType: "BOOL",
      address: { area: "I", byte: 0, bit: 7 },
    });
    expect(ir.variables[8]).toMatchObject({ address: { area: "Q", byte: 0, bit: 0 } });
    expect(ir.variables[9]).toMatchObject({ kind: "functionBlock", fbType: "TON" });
    expect(ir.variables[0]).not.toHaveProperty("address");
  });

  it("types integer boundaries by destination and folds untyped arithmetic exactly", () => {
    const ir = valid(
      "x : DINT;",
      "x := 32767; x := 32768; x := -32767; x := -32768; x := -2147483648; x := 1 + 2 * 3;",
    );
    const expressions = values(ir);
    expect(expressions).toMatchObject([
      { kind: "literal", dataType: "DINT", value: 32767 },
      { kind: "literal", dataType: "DINT", value: 32768 },
      { kind: "literal", dataType: "DINT", value: -32767 },
      { kind: "literal", dataType: "DINT", value: -32768 },
      { kind: "literal", dataType: "DINT", value: -2147483648 },
      { kind: "literal", dataType: "DINT", value: 7 },
    ]);
  });

  it("represents TIME as integer milliseconds and preserves real literal precision", () => {
    expect(
      values(
        valid(
          "t : TIME; r : LREAL; b : BOOL;",
          "t := T#1.2345s; r := -0.1; r := 1.0e100; b := FALSE;",
        ),
      ),
    ).toMatchObject([
      { kind: "literal", dataType: "TIME", value: 1234 },
      {
        kind: "literal",
        dataType: "LREAL",
        value: -0.1,
      },
      { kind: "literal", dataType: "LREAL", value: 1e100 },
      { kind: "literal", dataType: "BOOL", value: false },
    ]);
  });

  it("normalizes operators and resolves function opcodes and mixed-case variable references", () => {
    const ir = valid(
      "Value : INT; flag : BOOL;",
      "vAlUe := abs(INT#-2); flag := TRUE & NOT FALSE; Value := max(value, 32767);",
    );
    expect(ir.body[0]).toMatchObject({
      target: { kind: "variable", variable: 0, dataType: "INT" },
      value: { kind: "functionCall", function: "ABS", dataType: "INT" },
    });
    expect(values(ir)[1]).toMatchObject({
      kind: "binary",
      operator: "AND",
      dataType: "BOOL",
      right: { kind: "unary", operator: "NOT", dataType: "BOOL" },
    });
    expect(values(ir)[2]).toMatchObject({
      function: "MAX",
      dataType: "INT",
      args: [{ kind: "variable", variable: 0, dataType: "INT" }, { value: 32767 }],
    });
  });

  it("resolves FB input writes, input/output reads and reordered named inputs", () => {
    const ir = valid(
      "timer : TON; counter : CTU; b : BOOL; x : INT;",
      "timer.pt := T#1s; b := timer.IN; b := timer.q; timer(pT := T#500ms, iN := b); counter(pv := x, cu := b); x := counter.cv;",
    );
    expect(ir.body[0]).toMatchObject({
      target: { kind: "fbMember", variable: 0, port: "input", member: 1, dataType: "TIME" },
    });
    expect(values({ ...ir, body: ir.body.slice(1, 3) })).toMatchObject([
      { kind: "fbMember", variable: 0, port: "input", member: 0, dataType: "BOOL" },
      { kind: "fbMember", variable: 0, port: "output", member: 0, dataType: "BOOL" },
    ]);
    expect(ir.body[3]).toMatchObject({
      kind: "fbCall",
      variable: 0,
      inputs: [
        { name: "PT", input: 1 },
        { name: "IN", input: 0 },
      ],
    });
    expect(ir.body[4]).toMatchObject({
      variable: 1,
      inputs: [
        { name: "PV", input: 2 },
        { name: "CU", input: 0 },
      ],
    });
    expect(ir.body[5]).toMatchObject({
      value: { kind: "fbMember", variable: 1, port: "output", member: 1, dataType: "INT" },
    });
  });
});

describe("control flow and source constructs", () => {
  it("lowers IF/ELSIF/ELSE and constant CASE values, lists and ranges", () => {
    const ir = valid(
      "x : INT; b : BOOL;",
      `IF b THEN x := 1; ELSIF NOT b THEN x := 2; ELSE x := 3; END_IF;
CASE x OF 1 + 1, 3..5: x := 6; -1: RETURN; ELSE x := 0; END_CASE;`,
    );
    expect(ir.body[0]).toMatchObject({
      kind: "if",
      branches: [
        { condition: { variable: 1 }, body: [{ value: { value: 1 } }] },
        { condition: { operator: "NOT" }, body: [{ value: { value: 2 } }] },
      ],
      elseBody: [{ value: { value: 3 } }],
    });
    expect(ir.body[1]).toMatchObject({
      kind: "case",
      selector: { variable: 0, dataType: "INT" },
      branches: [
        {
          labels: [
            { kind: "value", value: 2 },
            { kind: "range", lower: 3, upper: 5 },
          ],
        },
        { labels: [{ value: -1 }], body: [{ kind: "return" }] },
      ],
      elseBody: [{ kind: "assignment" }],
    });
  });

  it("lowers FOR default/explicit steps, WHILE, REPEAT, EXIT and RETURN", () => {
    const ir = valid(
      "i : UINT; j : DINT; b : BOOL;",
      `FOR i := 1 TO 3 DO WHILE b DO EXIT; END_WHILE; END_FOR;
FOR j := 3 TO 1 BY -1 DO REPEAT b := FALSE; UNTIL b END_REPEAT; END_FOR;
RETURN;`,
    );
    expect(ir.body[0]).toMatchObject({
      kind: "for",
      variable: { variable: 0, dataType: "UINT" },
      from: { value: 1 },
      to: { value: 3 },
      step: { kind: "literal", dataType: "UINT", value: 1 },
      body: [{ kind: "while", condition: { variable: 2 }, body: [{ kind: "exit" }] }],
    });
    if (ir.body[0]!.kind !== "for") throw new Error("Expected FOR");
    expect(ir.body[0]!.step.span).toEqual(ir.body[0]!.variable.span);
    expect(ir.body[1]).toMatchObject({
      kind: "for",
      variable: { variable: 1, dataType: "DINT" },
      step: { kind: "literal", dataType: "DINT", value: -1 },
      body: [{ kind: "repeat", body: [{ kind: "assignment" }], until: { variable: 2 } }],
    });
    expect(ir.body[2]).toMatchObject({ kind: "return" });
  });

  it("uses complete grouping spans while preserving child and per-statement locations", () => {
    const source =
      "PROGRAM P\r\nVAR x : INT; timer : TON; END_VAR\r\nx := ((x + 2)); x := 3;\r\ntimer(\r\n IN := TRUE\r\n);\r\nEND_PROGRAM";
    const ir = compile(source).ir!;
    expect(ir.body[0]).toMatchObject({
      span: { line: 3, column: 1, endLine: 3, endColumn: 16 },
      value: {
        kind: "binary",
        span: { line: 3, column: 6, endLine: 3, endColumn: 15 },
        left: { span: { line: 3, column: 8, endLine: 3, endColumn: 9 } },
      },
    });
    expect(ir.body[1]!.span).toEqual({ line: 3, column: 17, endLine: 3, endColumn: 24 });
    expect(ir.body[2]!.span).toEqual({ line: 4, column: 1, endLine: 6, endColumn: 3 });
  });
});

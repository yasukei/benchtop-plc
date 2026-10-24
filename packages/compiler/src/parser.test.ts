import { parsePou } from "./parser.js";
import { describe, expect, it } from "vitest";
import type { Expression, Program } from "./index.js";
import { parse } from "./index.js";

function program(source: string): Program {
  const result = parse(source);
  expect(result.diagnostics).toEqual([]);
  if (!result.ast) throw new Error("Expected an AST");
  return result.ast;
}

function expression(source: string): Expression {
  const statement = program(`PROGRAM Main x := ${source}; END_PROGRAM`).body[0]!;
  if (statement.kind !== "assignment") throw new Error("Expected an assignment");
  return statement.value;
}

function shape(node: Expression): unknown {
  switch (node.kind) {
    case "null":
      return "NULL";
    case "dereference":
      return ["^", shape(node.reference)];
    case "index":
      return [shape(node.array), ...node.indices.map(shape)];
    case "field":
      return [shape(node.object), node.member.key];
    case "structureInitializer":
      return node.members.map((member) => [member.name.key, shape(member.value)]);
    case "elementBit":
      return [shape(node.element), node.member.key];
    case "arrayInitializer":
      return node.items.map((item) => [
        item.count ? shape(item.count) : 1,
        ...item.values.map(shape),
      ]);
    case "enumeration":
      return `${node.typeName.key}#${node.member.key}`;
    case "literal":
      return node.value;
    case "name":
      return node.name.key;
    case "member":
      return `${node.instance.key}.${node.member.key}`;
    case "group":
      return ["group", shape(node.expression)];
    case "unary":
      return [node.operator, shape(node.operand)];
    case "binary":
      return [node.operator, shape(node.left), shape(node.right)];
    case "functionCall":
      return [node.name.key, ...node.args.map(shape)];
  }
}

describe("ST parser", () => {
  it.each([
    "SINT",
    "USINT",
    "UDINT",
    "LINT",
    "ULINT",
    "BYTE",
    "WORD",
    "DWORD",
    "LWORD",
    "DATE",
    "TIME_OF_DAY",
    "TOD",
    "DATE_AND_TIME",
    "DT",
    "STRING",
    "WSTRING",
  ])("defers support checks for the elementary type %s", (type) => {
    const spelling = type.toLowerCase();
    const declaration = program(`PROGRAM P\nVAR x : ${spelling}; END_VAR\nEND_PROGRAM`)
      .declarations[0]!;
    expect(declaration.typeName).toEqual({
      name: spelling,
      key: type,
      span: { line: 2, column: 9, endLine: 2, endColumn: 9 + type.length },
    });
    const reserved = parse(`PROGRAM P VAR ${spelling} : INT; END_VAR END_PROGRAM`);
    expect(reserved.diagnostics).toMatchObject([
      { code: "syntax.reserved-identifier", args: { name: spelling } },
    ]);
  });

  it("parses multiple declaration blocks without performing semantic validation", () => {
    const ast = program(`pRoGrAm Demo
vAr
  a, Bee : iNt;
  input AT %ix12.9 : BOOL;
  waitTime : tImE := T#500ms;
  t1 : TON;
end_var
VAR
  unknown : FutureType := missing + 1;
END_VAR
END_PROGRAM`);
    expect(ast.name).toEqual({
      name: "Demo",
      key: "DEMO",
      span: { line: 1, column: 9, endLine: 1, endColumn: 13 },
    });
    expect(ast.declarations).toHaveLength(5);
    expect(ast.declarations[0]).toMatchObject({
      kind: "declaration",
      names: [
        { name: "a", key: "A" },
        { name: "Bee", key: "BEE" },
      ],
      typeName: { name: "iNt", key: "INT" },
      span: { line: 3, column: 3, endLine: 3, endColumn: 16 },
    });
    expect(ast.declarations[0]).not.toHaveProperty("initializer");
    expect(ast.declarations[1]?.address).toEqual({
      text: "%ix12.9",
      area: "I",
      byte: 12,
      bit: 9,
      span: { line: 4, column: 12, endLine: 4, endColumn: 19 },
    });
    expect(ast.declarations[2]?.initializer).toMatchObject({
      kind: "literal",
      literalKind: "time",
      text: "T#500ms",
      value: 500,
    });
    expect(ast.declarations[3]?.typeName.key).toBe("TON");
    expect(ast.declarations[4]?.typeName.key).toBe("FUTURETYPE");
  });

  it.each([
    [
      "1 OR 2 XOR 3 AND 4 = 5 < 6 + 7 * -8",
      ["OR", 1, ["XOR", 2, ["AND", 3, ["=", 4, ["<", 5, ["+", 6, ["*", 7, ["-", 8]]]]]]]],
    ],
    ["a - b - c", ["-", ["-", "A", "B"], "C"]],
    ["a / b * c MOD d", ["MOD", ["*", ["/", "A", "B"], "C"], "D"]],
    ["a + b - c", ["-", ["+", "A", "B"], "C"]],
    ["a < b <= c > d >= e", [">=", [">", ["<=", ["<", "A", "B"], "C"], "D"], "E"]],
    ["a = b <> c", ["<>", ["=", "A", "B"], "C"]],
    ["a AND b & c", ["AND", ["AND", "A", "B"], "C"]],
    ["a XOR b XOR c", ["XOR", ["XOR", "A", "B"], "C"]],
    ["a OR b OR c", ["OR", ["OR", "A", "B"], "C"]],
    ["NOT -+a * b", ["*", ["NOT", ["-", ["+", "A"]]], "B"]],
    ["(1 + 2) * abs(-3)", ["*", ["group", ["+", 1, 2]], ["ABS", ["-", 3]]]],
    ["max(1, min(2, 3)) + t1.ET", ["+", ["MAX", 1, ["MIN", 2, 3]], "T1.ET"]],
    ["future()", ["FUTURE"]],
    ["true OR false", ["OR", true, false]],
    ["2#10 + 2#1000 + 16#10 + 1.0e3 + T#-1s", ["+", ["+", ["+", ["+", 2, 8], 16], 1000], -1000]],
  ])("respects precedence and associativity in %s", (source, expected) => {
    expect(shape(expression(source))).toEqual(expected);
  });

  it("parses assignments, member writes and named FB inputs with source spelling", () => {
    const ast = program(
      "PROGRAM Main\nx := y;\nt1.IN := True;\nt1(In := x, pT := T#1s);\nt2();\nEND_PROGRAM",
    );
    expect(ast.body[0]).toMatchObject({
      kind: "assignment",
      target: { kind: "name", name: { name: "x", key: "X" } },
      span: { line: 2, column: 1, endLine: 2, endColumn: 8 },
    });
    expect(ast.body[1]).toMatchObject({
      kind: "assignment",
      target: { kind: "member", instance: { key: "T1" }, member: { key: "IN" } },
    });
    expect(ast.body[2]).toMatchObject({
      kind: "fbCall",
      instance: { name: "t1", key: "T1" },
      inputs: [
        {
          name: { name: "In", key: "IN" },
          value: { kind: "name" },
          span: { line: 4, column: 4, endLine: 4, endColumn: 11 },
        },
        { name: { name: "pT", key: "PT" }, value: { kind: "literal", value: 1000 } },
      ],
    });
    expect(ast.body[3]).toMatchObject({ kind: "fbCall", inputs: [] });
  });

  it("parses IF/ELSIF/ELSE with nesting and empty branches", () => {
    const ast = program(`PROGRAM Main
IF x THEN
  IF y THEN x := 1; ELSE x := 2; END_IF;
ELSIF y THEN
ELSIF z THEN RETURN;
ELSE x := 3;
END_IF;
END_PROGRAM`);
    const statement = ast.body[0]!;
    expect(statement.kind).toBe("if");
    if (statement.kind !== "if") return;
    expect(statement.branches).toHaveLength(3);
    expect(statement.branches.map(({ body }) => body.map(({ kind }) => kind))).toEqual([
      ["if"],
      [],
      ["return"],
    ]);
    expect(statement.branches[1]?.span).toEqual({ line: 4, column: 1, endLine: 4, endColumn: 13 });
    expect(statement.elseBody.map(({ kind }) => kind)).toEqual(["assignment"]);
    expect(statement.span).toEqual({ line: 2, column: 1, endLine: 7, endColumn: 8 });
  });

  it("parses CASE lists/ranges and distinguishes label expressions from statements", () => {
    const ast = program(`PROGRAM Main
CASE n OF
  1, 3..5: x := 1; t1(IN := TRUE);
  -2, 16#A..16#F:
  limit + 1: CASE y OF 0: RETURN; ELSE EXIT; END_CASE;
  ELSE x := 0;
END_CASE;
END_PROGRAM`);
    const statement = ast.body[0]!;
    if (statement.kind !== "case") throw new Error("Expected CASE");
    expect(statement.branches).toHaveLength(3);
    expect(statement.branches[0]?.labels).toMatchObject([
      { kind: "value", value: { value: 1 } },
      {
        kind: "range",
        lower: { value: 3 },
        upper: { value: 5 },
        span: { line: 3, column: 6, endLine: 3, endColumn: 10 },
      },
    ]);
    expect(statement.branches.map(({ body }) => body.map(({ kind }) => kind))).toEqual([
      ["assignment", "fbCall"],
      [],
      ["case"],
    ]);
    expect(statement.branches[2]?.labels[0]).toMatchObject({
      kind: "value",
      value: { kind: "binary", operator: "+" },
    });
    expect(statement.elseBody).toHaveLength(1);
  });

  it("parses FOR, WHILE, REPEAT, EXIT and RETURN, including optional BY", () => {
    const ast = program(`PROGRAM Main
FOR i := 1 TO 10 BY -2 DO
  WHILE x DO
    REPEAT x := x - 1; UNTIL x = 0 END_REPEAT;
    EXIT;
  END_WHILE;
END_FOR;
FOR j := 0 TO 1 DO END_FOR;
RETURN;
END_PROGRAM`);
    const loop = ast.body[0]!;
    if (loop.kind !== "for") throw new Error("Expected FOR");
    expect(loop.variable.key).toBe("I");
    expect(shape(loop.from)).toBe(1);
    expect(shape(loop.to)).toBe(10);
    expect(shape(loop.step!)).toEqual(["-", 2]);
    const whileLoop = loop.body[0]!;
    if (whileLoop.kind !== "while") throw new Error("Expected WHILE");
    expect(whileLoop.body.map(({ kind }) => kind)).toEqual(["repeat", "exit"]);
    const repeat = whileLoop.body[0]!;
    if (repeat.kind !== "repeat") throw new Error("Expected REPEAT");
    expect(shape(repeat.until)).toEqual(["=", "X", 0]);
    expect(repeat.body.map(({ kind }) => kind)).toEqual(["assignment"]);
    expect(ast.body[1]).not.toHaveProperty("step");
    expect(ast.body[2]?.kind).toBe("return");
  });

  it("preserves parentheses and precise inner spans", () => {
    const value = expression("(a +\n  2)");
    expect(value.span).toEqual({ line: 1, column: 19, endLine: 2, endColumn: 5 });
    if (value.kind !== "group") throw new Error("Expected group");
    expect(value.expression.span).toEqual({ line: 1, column: 20, endLine: 2, endColumn: 4 });
  });

  it("accepts empty blocks, empty statements and an optional program semicolon", () => {
    expect(
      program(
        "PROGRAM p VAR END_VAR ; IF TRUE THEN ELSE END_IF; CASE 1 OF END_CASE; WHILE TRUE DO END_WHILE; REPEAT UNTIL TRUE END_REPEAT; END_PROGRAM;",
      ).body.map(({ kind }) => kind),
    ).toEqual(["if", "case", "while", "repeat"]);
  });
});

describe("syntax diagnostics", () => {
  it.each([
    ["IF x THEN y :=", "syntax.unexpected-eof", {}],
    ["IF x", "syntax.unexpected-eof", {}],
    ["IF x THEN y := 1", "syntax.unexpected-eof", {}],
    ["IF x THEN WHILE y DO", "syntax.missing-end", { expected: "END_WHILE" }],
    ["REPEAT x := 1;", "syntax.unexpected-eof", {}],
    ["REPEAT UNTIL", "syntax.unexpected-eof", {}],
    ["REPEAT UNTIL x", "syntax.missing-end", { expected: "END_REPEAT" }],
    ["CASE x OF 1:", "syntax.missing-end", { expected: "END_CASE" }],
    ["CASE x OF 1,", "syntax.unexpected-eof", {}],
    ["VAR x :", "syntax.unexpected-eof", {}],
  ])("selects the innermost unfinished construct at EOF after %s", (suffix, code, args) => {
    expect(parse(`PROGRAM P\n${suffix}`)).toEqual({
      ast: null,
      diagnostics: [
        {
          code,
          severity: "error",
          pou: "P",
          args,
          span: { line: 2, column: suffix.length + 1, endLine: 2, endColumn: suffix.length + 1 },
        },
      ],
    });
  });

  it.each([
    [
      "PROGRAM P\nx := 1\nEND_PROGRAM",
      "syntax.expected-token",
      { expected: ";", found: "END_PROGRAM" },
      3,
      1,
      3,
      12,
    ],
    ["PROGRAM P\nx = 1;\nEND_PROGRAM", "syntax.assignment-operator", {}, 2, 3, 2, 4],
    [
      "PROGRAM P\nIF TRUE THEN\nx := 1;\nEND_PROGRAM",
      "syntax.missing-end",
      { expected: "END_IF" },
      4,
      1,
      4,
      1,
    ],
    ["PROGRAM P\nIF TRUE THEN", "syntax.missing-end", { expected: "END_IF" }, 2, 13, 2, 13],
    ["PROGRAM P\nVAR x : INT;", "syntax.missing-end", { expected: "END_VAR" }, 2, 13, 2, 13],
    ["PROGRAM P", "syntax.missing-end", { expected: "END_PROGRAM" }, 1, 10, 1, 10],
    ["PROGRAM", "syntax.unexpected-eof", {}, 1, 8, 1, 8],
    ["PROGRAM 1 END_PROGRAM", "syntax.expected-identifier", { found: "1" }, 1, 9, 1, 10],
    ["PROGRAM IF END_PROGRAM", "syntax.reserved-identifier", { name: "IF" }, 1, 9, 1, 11],
    [
      "PROGRAM P VAR true : BOOL; END_VAR END_PROGRAM",
      "syntax.reserved-identifier",
      { name: "true" },
      1,
      15,
      1,
      19,
    ],
    [
      "PROGRAM P\nVAR x : INT = 1; END_VAR END_PROGRAM",
      "syntax.assignment-operator",
      {},
      2,
      13,
      2,
      14,
    ],
    ["PROGRAM P\nf(IN = TRUE); END_PROGRAM", "syntax.assignment-operator", {}, 2, 6, 2, 7],
    [
      "PROGRAM P\nx := ; END_PROGRAM",
      "syntax.expected-token",
      { expected: "expression", found: ";" },
      2,
      6,
      2,
      7,
    ],
    [
      "PROGRAM P\nx := (1; END_PROGRAM",
      "syntax.expected-token",
      { expected: ")", found: ";" },
      2,
      8,
      2,
      9,
    ],
    ["PROGRAM P\n@ END_PROGRAM", "lex.invalid-character", { character: "@" }, 2, 1, 2, 2],
    ["PROGRAM P\n(* unfinished", "lex.unterminated-comment", {}, 2, 1, 2, 14],
    [
      "PROGRAM P END_PROGRAM x",
      "syntax.expected-token",
      { expected: "eof", found: "x" },
      1,
      23,
      1,
      24,
    ],
  ])("reports code and span for %j", (source, code, args, line, column, endLine, endColumn) => {
    expect(parse(source)).toEqual({
      ast: null,
      diagnostics: [
        {
          code,
          severity: "error",
          ...(source.startsWith("PROGRAM P") ? { pou: "P" } : {}),
          args,
          span: { line, column, endLine, endColumn },
        },
      ],
    });
  });

  it.each([";", "y"])("reports a stray %s after UNTIL as an unexpected token", (found) => {
    expect(parse(`PROGRAM P\nREPEAT x := 1; UNTIL x = 0 ${found} END_REPEAT; END_PROGRAM`)).toEqual(
      {
        ast: null,
        diagnostics: [
          {
            code: "syntax.expected-token",
            severity: "error",
            pou: "P",
            args: { expected: "END_REPEAT", found },
            span: { line: 2, column: 28, endLine: 2, endColumn: 29 },
          },
        ],
      },
    );
  });

  it("uses the canonical address token kind in diagnostics", () => {
    expect(parse("PROGRAM P\nVAR x AT input : BOOL; END_VAR\nEND_PROGRAM")).toEqual({
      ast: null,
      diagnostics: [
        {
          code: "syntax.expected-token",
          severity: "error",
          pou: "P",
          args: { expected: "address", found: "input" },
          span: { line: 2, column: 10, endLine: 2, endColumn: 15 },
        },
      ],
    });
  });

  it.each([
    ["FOR i := 1 TO 2 DO", "END_FOR"],
    ["WHILE TRUE DO", "END_WHILE"],
    ["REPEAT UNTIL TRUE", "END_REPEAT"],
    ["CASE x OF 1: x := 2;", "END_CASE"],
    ["IF TRUE THEN WHILE TRUE DO END_WHILE;", "END_IF"],
  ])("reports missing terminator for %s", (body, expected) => {
    expect(parse(`PROGRAM P ${body} END_PROGRAM`).diagnostics).toMatchObject([
      { code: "syntax.missing-end", args: { expected } },
    ]);
  });

  it.each([
    "FUNCTION F END_FUNCTION",
    "FUNCTION_BLOCK F END_FUNCTION_BLOCK",
    "PROGRAM P VAR_INPUT x : INT; END_VAR END_PROGRAM",
  ])("does not accept unsupported syntax %s", (source) => {
    expect(parse(source).ast).toBeNull();
    expect(parse(source).diagnostics).toHaveLength(1);
  });
});

it("parses formal function inputs, output bindings and function statements with exact spans", () => {
  const source = "PROGRAM P\nSPLIT_DATE(IN := d, YEAR => y, MONTH => m, DAY => dd);\nEND_PROGRAM";
  const statement = program(source).body[0]!;
  expect(statement).toMatchObject({
    kind: "call",
    span: { line: 2, column: 1, endLine: 2, endColumn: 55 },
    call: {
      kind: "functionCall",
      name: { key: "SPLIT_DATE" },
      inputNames: [{ key: "IN" }],
      args: [{ kind: "name", name: { key: "D" } }],
      outputs: [
        { name: { key: "YEAR" }, target: { kind: "name", name: { key: "Y" } } },
        { name: { key: "MONTH" }, target: { kind: "name", name: { key: "M" } } },
        { name: { key: "DAY" }, target: { kind: "name", name: { key: "DD" } } },
      ],
    },
  });
  expect(shape(expression("CONCAT_DATE(DAY := 29, MONTH := 2, YEAR := 2024)"))).toEqual([
    "CONCAT_DATE",
    29,
    2,
    2024,
  ]);
});
it.each([
  "SPLIT_DATE(d, YEAR => y);",
  "SPLIT_DATE(IN := d, YEAR => 1);",
  "SPLIT_DATE(IN := d, YEAR => (y));",
  "SPLIT_DATE(IN := d, YEAR => y + 1);",
])("rejects mixed call syntax and non-reference output targets: %s", (body) => {
  expect(parse(`PROGRAM P ${body} END_PROGRAM`).ast).toBeNull();
});

it("parses chained member access for later type checking", () => {
  expect(shape(expression("a.b.c"))).toEqual(["A.B", "C"]);
});

it("parses open array dimensions and inline array function results", () => {
  const source =
    "FUNCTION F : ARRAY[1..2] OF INT VAR_IN_OUT a : ARRAY[*, *] OF INT; END_VAR END_FUNCTION";
  const result = parsePou(source);
  expect(result.diagnostics).toEqual([]);
  expect(result.ast?.resultArray?.dimensions).toHaveLength(1);
  expect(result.ast?.declarations[0]?.array?.dimensions).toEqual(["*", "*"]);
});

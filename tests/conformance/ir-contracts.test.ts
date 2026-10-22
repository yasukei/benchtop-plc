import type {
  Expression,
  LiteralExpression,
  ProgramIR,
  SourceSpan,
  Statement,
  VariableReference,
} from "@benchtop-plc/core";
import { expect, it } from "vitest";

it("represents every milestone IR variant as transportable data", () => {
  const span: SourceSpan = { line: 1, column: 1, endLine: 1, endColumn: 2 };
  const int: LiteralExpression = { kind: "literal", dataType: "INT", value: 1, span };
  const bool: LiteralExpression = { kind: "literal", dataType: "BOOL", value: true, span };
  const variable: VariableReference & { dataType: "INT" } = {
    kind: "variable",
    variable: 0,
    dataType: "INT",
    span,
  };
  const expressions: Record<Expression["kind"], Expression> = {
    userFunctionCall: {
      kind: "userFunctionCall",
      function: 0,
      inputs: [],
      outputs: [],
      dataType: "INT",
      span,
    },
    literal: int,
    bit: { kind: "bit", variable: 2, bit: 15, dataType: "BOOL", span },
    variable,
    fbMember: { kind: "fbMember", variable: 1, port: "input", member: 0, dataType: "BOOL", span },
    unary: { kind: "unary", operator: "-", operand: int, dataType: "INT", span },
    binary: { kind: "binary", operator: "MOD", left: variable, right: int, dataType: "INT", span },
    functionCall: {
      kind: "functionCall",
      function: "ABS",
      args: [variable],
      dataType: "INT",
      span,
    },
  };
  const statements: Record<Statement["kind"], Statement> = {
    call: {
      kind: "call",
      call: expressions.functionCall as import("@benchtop-plc/core").FunctionCallExpression,
      span,
    },
    assignment: { kind: "assignment", target: variable, value: expressions.functionCall, span },
    fbCall: {
      kind: "fbCall",
      variable: 1,
      inputs: [{ name: "IN", input: 0, value: bool, span }],
      span,
    },
    if: {
      kind: "if",
      branches: [
        { condition: bool, body: [], span },
        { condition: bool, body: [{ kind: "return", span }], span },
      ],
      elseBody: [{ kind: "return", span }],
      span,
    },
    case: {
      kind: "case",
      selector: variable,
      branches: [
        {
          labels: [
            { kind: "value", value: 1, span },
            { kind: "range", lower: 3, upper: 5, span },
          ],
          body: [],
          span,
        },
      ],
      elseBody: [],
      span,
    },
    for: {
      kind: "for",
      variable,
      from: int,
      to: int,
      step: expressions.unary,
      body: [{ kind: "exit", span }],
      span,
    },
    while: { kind: "while", condition: bool, body: [{ kind: "exit", span }], span },
    repeat: { kind: "repeat", body: [], until: bool, span },
    exit: { kind: "exit", span },
    return: { kind: "return", span },
  };
  const ir: ProgramIR = {
    kind: "program",
    name: "Contracts",
    span,
    variables: [
      { kind: "scalar", name: "n", key: "N", dataType: "INT", initialValue: 0, span },
      {
        kind: "functionBlock",
        name: "timer",
        key: "TIMER",
        fbType: "TON",
        initialValue: null,
        span,
      },
    ],
    // EXIT is only valid in loops, so omit the standalone variant from this program body.
    body: Object.values(statements).filter((statement) => statement.kind !== "exit"),
  };
  ir.body.push({
    kind: "assignment",
    target: {
      kind: "fbMember",
      variable: 1,
      port: "input",
      member: 0,
      dataType: "BOOL",
      span,
    },
    value: bool,
    span,
  });
  expect(JSON.parse(JSON.stringify({ ir, expressions, statements }))).toStrictEqual({
    ir,
    expressions,
    statements,
  });
  expect(structuredClone({ ir, expressions, statements })).toStrictEqual({
    ir,
    expressions,
    statements,
  });
});

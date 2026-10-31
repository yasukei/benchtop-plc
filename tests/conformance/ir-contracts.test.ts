import type {
  ConfigurationIR,
  Expression,
  LiteralExpression,
  ProgramIR,
  SourceSpan,
  Statement,
  VariableReference,
} from "@benchtop-plc/core";
import { methodImplementation, snapshotVariable } from "@benchtop-plc/core";
import { compileProject } from "@benchtop-plc/compiler";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";
import { expect, it } from "vitest";

it("transports each inherited implementation once across a three-level hierarchy", () => {
  const compiled = compileProject([
    `PROGRAM Main VAR d: Leaf; seen: INT; END_VAR
      d(); seen := d.Read(); END_PROGRAM`,
    `FUNCTION_BLOCK Leaf EXTENDS Middle
      VAR leafMember: INT := 5; END_VAR
      METHOD PUBLIC OVERRIDE Change
        SUPER.Change(); n := n + leafMember;
      END_METHOD
    END_FUNCTION_BLOCK`,
    `FUNCTION_BLOCK Root
      VAR_OUTPUT n: INT; END_VAR
      METHOD PUBLIC Read : INT
        Read := n;
      END_METHOD
      METHOD PUBLIC Change
        n := n + 1;
      END_METHOD
      METHOD PUBLIC Value : INT
        Value := 11;
      END_METHOD
      Change();
    END_FUNCTION_BLOCK`,
    `FUNCTION_BLOCK Middle EXTENDS Root
      VAR middleMember: INT := 3; END_VAR
      METHOD PUBLIC OVERRIDE Value : INT
        Value := 22;
      END_METHOD
      METHOD PUBLIC Added : INT
        Added := middleMember;
      END_METHOD
    END_FUNCTION_BLOCK`,
  ]);
  expect(compiled.diagnostics).toEqual([]);
  const serialized = JSON.stringify(compiled.ir);
  const transported: ConfigurationIR = JSON.parse(serialized);
  expect(transported).toStrictEqual(compiled.ir);
  expect(structuredClone(compiled.ir)).toStrictEqual(transported);
  const [leaf, root, middle] = transported.functionBlocks!;
  expect(leaf).toMatchObject({
    base: 2,
    bodyOwner: 1,
    body: [],
    methodTable: { READ: 0, CHANGE: 1, VALUE: 2, ADDED: 3 },
    methods: [
      { block: 1, method: 0 },
      { declaringType: 0, memberCount: 3 },
      { block: 2, method: 2 },
      { block: 2, method: 3 },
    ],
  });
  expect(middle).toMatchObject({
    base: 1,
    bodyOwner: 1,
    body: [],
    methods: [
      { block: 1, method: 0 },
      { block: 1, method: 1 },
      { declaringType: 2 },
      { declaringType: 2 },
    ],
  });
  expect(root!.body).toHaveLength(1);
  expect(serialized.split(JSON.stringify(root!.body))).toHaveLength(2);
  expect(root!.methods).toHaveLength(3);
  const implementations = transported.functionBlocks!.flatMap((block) =>
    (block.methods ?? []).filter((entry) => "body" in entry),
  );
  expect(implementations.map((entry) => entry.name)).toEqual([
    "Change",
    "Read",
    "Change",
    "Value",
    "Value",
    "Added",
  ]);
  expect(serialized.match(/"memberCount":/g)).toHaveLength(6);
  for (const implementation of implementations)
    expect(serialized.split(JSON.stringify(implementation.body))).toHaveLength(2);
  expect(leaf!.methods![0]).toStrictEqual({ block: 1, method: 0 });
  expect(middle!.methods![0]).toStrictEqual({ block: 1, method: 0 });
  expect(methodImplementation(transported.functionBlocks!, 0, 0)).toBe(root!.methods![0]);
  expect(methodImplementation(transported.functionBlocks!, 0, 2)).toBe(middle!.methods![2]);

  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(transported);
  runtime.watch(transported.variables.map((_, id) => id));
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  const seen = transported.variables.findIndex((variable) => variable.name === "mainInstance.seen");
  expect(snapshotVariable(runtime.snapshot(), seen)).toMatchObject({ value: 6 });
});

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
    null: { kind: "null", dataType: { kind: "reference", target: "INT" }, span },
    instanceReference: {
      kind: "instanceReference",
      target: variable,
      dataType: { kind: "interface", name: "I", extends: [] },
      span,
    },
    referenceOf: {
      kind: "referenceOf",
      target: variable,
      dataType: { kind: "reference", target: "INT" },
      span,
    },
    dereference: {
      kind: "dereference",
      reference: { ...variable, dataType: { kind: "reference", target: "INT" } },
      dataType: "INT",
      span,
    },
    arrayBound: {
      kind: "arrayBound",
      array: variable,
      dimension: 0,
      upper: false,
      dataType: "DINT",
      span,
    },
    userFunctionCall: {
      kind: "userFunctionCall",
      function: 0,
      inputs: [],
      outputs: [],
      dataType: "INT",
      span,
    },
    structureMember: {
      kind: "structureMember",
      object: { ...variable, dataType: { kind: "named", name: "Point" } },
      member: 0,
      dataType: "INT",
      span,
    },
    index: {
      kind: "index",
      array: {
        ...variable,
        dataType: { kind: "array", dimensions: [{ lower: 1, upper: 2 }], element: "INT" },
      },
      indices: [int],
      dataType: "INT",
      span,
    },
    elementBit: {
      kind: "elementBit",
      element: { kind: "index", array: variable, indices: [int], dataType: "WORD", span },
      bit: 3,
      dataType: "BOOL",
      span,
    },
    literal: int,
    bit: { kind: "bit", variable: 2, bit: 15, dataType: "BOOL", span },
    variable,
    userFbMember: {
      kind: "userFbMember",
      variable: 0,
      port: "output",
      member: 0,
      dataType: "INT",
      span,
    },
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
    superCall: { kind: "superCall", block: 0, span },
    userFbCall: { kind: "userFbCall", variable: 0, inputs: [], span },
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

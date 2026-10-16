import type {
  BinaryExpression,
  BinaryOperator,
  DataType,
  Expression,
  FunctionBlockMemberReference,
  ProgramIR,
  SourceSpan,
  VariableReference,
} from "@benchtop-plc/core";

// Hand-written lowering of reference.st, not compiler output. Helpers only remove repeated
// object syntax; the exported IR contains plain objects, arrays and primitive values.
const span = (line: number, column: number, endColumn: number, endLine = line): SourceSpan => ({
  line,
  column,
  endLine,
  endColumn,
});
const ref = (
  variable: number,
  dataType: DataType,
  line: number,
  column: number,
  endColumn: number,
): VariableReference => ({
  kind: "variable",
  variable,
  dataType,
  span: span(line, column, endColumn),
});
const output = (
  variable: number,
  line: number,
  column: number,
  endColumn: number,
): FunctionBlockMemberReference => ({
  kind: "fbMember",
  variable,
  port: "output",
  member: 0,
  dataType: "BOOL",
  span: span(line, column, endColumn),
});
const binary = (
  operator: BinaryOperator,
  dataType: DataType,
  left: Expression,
  right: Expression,
): BinaryExpression => ({
  kind: "binary",
  operator,
  dataType,
  left,
  right,
  span: {
    line: left.span.line,
    column: left.span.column,
    endLine: right.span.endLine,
    endColumn: right.span.endColumn,
  },
});

export const referenceIR: ProgramIR = {
  kind: "program",
  name: "Main",
  span: span(1, 1, 12, 36),
  variables: [
    {
      kind: "scalar",
      name: "StartPB",
      key: "STARTPB",
      dataType: "BOOL",
      initialValue: false,
      address: { area: "I", byte: 0, bit: 0 },
      span: span(3, 5, 32),
    },
    {
      kind: "scalar",
      name: "StopPB",
      key: "STOPPB",
      dataType: "BOOL",
      initialValue: false,
      address: { area: "I", byte: 0, bit: 1 },
      span: span(4, 5, 32),
    },
    {
      kind: "scalar",
      name: "ResetPB",
      key: "RESETPB",
      dataType: "BOOL",
      initialValue: false,
      address: { area: "I", byte: 0, bit: 2 },
      span: span(5, 5, 32),
    },
    {
      kind: "scalar",
      name: "Running",
      key: "RUNNING",
      dataType: "BOOL",
      initialValue: false,
      address: { area: "Q", byte: 0, bit: 0 },
      span: span(6, 5, 32),
    },
    {
      kind: "scalar",
      name: "Lamp",
      key: "LAMP",
      dataType: "BOOL",
      initialValue: false,
      address: { area: "Q", byte: 0, bit: 1 },
      span: span(7, 5, 32),
    },
    {
      kind: "scalar",
      name: "Alarm",
      key: "ALARM",
      dataType: "BOOL",
      initialValue: false,
      address: { area: "Q", byte: 0, bit: 2 },
      span: span(8, 5, 32),
    },
    {
      kind: "functionBlock",
      name: "tBlinkOn",
      key: "TBLINKON",
      fbType: "TON",
      initialValue: null,
      span: span(9, 5, 21),
    },
    {
      kind: "functionBlock",
      name: "tBlinkOff",
      key: "TBLINKOFF",
      fbType: "TON",
      initialValue: null,
      span: span(10, 5, 21),
    },
    {
      kind: "functionBlock",
      name: "rtLamp",
      key: "RTLAMP",
      fbType: "R_TRIG",
      initialValue: null,
      span: span(11, 5, 24),
    },
    {
      kind: "scalar",
      name: "Blinks",
      key: "BLINKS",
      dataType: "INT",
      initialValue: 0,
      span: span(12, 5, 21),
    },
    {
      kind: "scalar",
      name: "BlinkTime",
      key: "BLINKTIME",
      dataType: "TIME",
      initialValue: 500,
      span: span(13, 5, 33),
    },
  ],
  body: [
    {
      kind: "assignment",
      span: span(17, 1, 48),
      target: ref(3, "BOOL", 17, 1, 8),
      value: {
        ...binary(
          "AND",
          "BOOL",
          binary("OR", "BOOL", ref(0, "BOOL", 17, 13, 20), ref(3, "BOOL", 17, 24, 31)),
          {
            kind: "unary",
            operator: "NOT",
            dataType: "BOOL",
            operand: ref(1, "BOOL", 17, 41, 47),
            span: span(17, 37, 47),
          },
        ),
        span: span(17, 12, 47),
      },
    },
    {
      kind: "fbCall",
      variable: 6,
      span: span(20, 1, 62),
      inputs: [
        {
          name: "IN",
          input: 0,
          span: span(20, 10, 43),
          value: binary("AND", "BOOL", ref(3, "BOOL", 20, 16, 23), {
            kind: "unary",
            operator: "NOT",
            dataType: "BOOL",
            span: span(20, 28, 43),
            operand: output(7, 20, 32, 43),
          }),
        },
        { name: "PT", input: 1, span: span(20, 45, 60), value: ref(10, "TIME", 20, 51, 60) },
      ],
    },
    {
      kind: "fbCall",
      variable: 7,
      span: span(21, 1, 46),
      inputs: [
        { name: "IN", input: 0, span: span(21, 11, 27), value: output(6, 21, 17, 27) },
        { name: "PT", input: 1, span: span(21, 29, 44), value: ref(10, "TIME", 21, 35, 44) },
      ],
    },
    {
      kind: "assignment",
      span: span(22, 1, 20),
      target: ref(4, "BOOL", 22, 1, 5),
      value: output(6, 22, 9, 19),
    },
    {
      kind: "fbCall",
      variable: 8,
      span: span(25, 1, 21),
      inputs: [{ name: "CLK", input: 0, span: span(25, 8, 19), value: ref(4, "BOOL", 25, 15, 19) }],
    },
    {
      kind: "if",
      span: span(26, 1, 8, 28),
      elseBody: [],
      branches: [
        {
          span: span(26, 1, 26, 27),
          condition: output(8, 26, 4, 12),
          body: [
            {
              kind: "assignment",
              span: span(27, 5, 26),
              target: ref(9, "INT", 27, 5, 11),
              value: binary("+", "INT", ref(9, "INT", 27, 15, 21), {
                kind: "literal",
                dataType: "INT",
                value: 1,
                span: span(27, 24, 25),
              }),
            },
          ],
        },
      ],
    },
    {
      kind: "if",
      span: span(30, 1, 8, 32),
      elseBody: [],
      branches: [
        {
          span: span(30, 1, 17, 31),
          condition: ref(2, "BOOL", 30, 4, 11),
          body: [
            {
              kind: "assignment",
              span: span(31, 5, 17),
              target: ref(9, "INT", 31, 5, 11),
              value: { kind: "literal", dataType: "INT", value: 0, span: span(31, 15, 16) },
            },
          ],
        },
      ],
    },
    {
      kind: "assignment",
      span: span(34, 1, 23),
      target: ref(5, "BOOL", 34, 1, 6),
      value: binary(">=", "BOOL", ref(9, "INT", 34, 10, 16), {
        kind: "literal",
        dataType: "INT",
        value: 10,
        span: span(34, 20, 22),
      }),
    },
  ],
};

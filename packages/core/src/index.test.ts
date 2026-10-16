import { expect, expectTypeOf, it } from "vitest";
import type {
  AssignmentTarget,
  Diagnostic,
  DirectAddress,
  LiteralExpression,
  ProgramIR,
  RuntimeToUiMessage,
  ScalarVariable,
  SourceSpan,
  TypedValue,
  UiToRuntimeMessage,
} from "./index.js";

it("exports typed contracts through the package entry point", () => {
  const span: SourceSpan = { line: 1, column: 1, endLine: 1, endColumn: 2 };
  const literal: LiteralExpression = { kind: "literal", dataType: "BOOL", value: true, span };
  expectTypeOf(literal.value).toEqualTypeOf<boolean>();
  expectTypeOf<ProgramIR["span"]>().toEqualTypeOf<SourceSpan>();

  // These assertions are checked by tsc as well as by Vitest's runtime test.
  // @ts-expect-error BOOL values cannot be numeric.
  const invalidValue: TypedValue = { dataType: "BOOL", value: 1 };
  // @ts-expect-error Scalar initializers must match their declared elementary type.
  const invalidVariable: ScalarVariable = {
    kind: "scalar",
    name: "x",
    key: "X",
    dataType: "INT",
    initialValue: true,
    span,
  };
  const invalidTarget: AssignmentTarget = {
    kind: "fbMember",
    variable: 0,
    // @ts-expect-error An FB output cannot be an assignment target.
    port: "output",
    member: 0,
    dataType: "BOOL",
    span,
  };
  // @ts-expect-error Milestone 1 only supports byte zero.
  const invalidAddress: DirectAddress = { area: "I", byte: 1, bit: 0 };
  // @ts-expect-error The input image contains exactly eight bits.
  const invalidInput: UiToRuntimeMessage = { type: "setInput", bit: 8, value: true };
  // @ts-expect-error A write requires a typed value.
  const invalidWrite: UiToRuntimeMessage = { type: "write", variable: 0, value: 1 };
  const address: DirectAddress = { area: "I", byte: 0, bit: 0 };
  // @ts-expect-error Numeric variables cannot have a bit address.
  const invalidMapped: ScalarVariable = {
    kind: "scalar",
    name: "x",
    key: "X",
    dataType: "INT",
    initialValue: 0,
    address,
    span,
  };
  expect([
    invalidValue,
    invalidVariable,
    invalidTarget,
    invalidAddress,
    invalidInput,
    invalidWrite,
    invalidMapped,
  ]).toHaveLength(7);
});

it("describes every protocol command and event as plain data", () => {
  const ir: ProgramIR = {
    kind: "program",
    name: "Empty",
    variables: [],
    body: [],
    span: { line: 1, column: 1, endLine: 2, endColumn: 12 },
  };
  const commands: UiToRuntimeMessage[] = [
    { type: "load", ir },
    { type: "run" },
    { type: "stop" },
    { type: "step" },
    { type: "coldReset" },
    { type: "setCycle", ms: 10 },
    { type: "setInput", bit: 7, value: true },
    { type: "force", variable: 0, value: { dataType: "BOOL", value: false } },
    { type: "force", variable: 0, value: null },
    { type: "write", variable: 1, value: { dataType: "TIME", value: 500 } },
    { type: "estop", active: true },
  ];
  const diagnostic: Diagnostic = { code: "runtime.example", severity: "error", args: { limit: 1 } };
  const events: RuntimeToUiMessage[] = [
    ...(["STOP", "RUN", "ESTOP", "FAULT"] as const).map((state) => ({
      type: "state" as const,
      state,
    })),
    { type: "fault", diagnostic },
    {
      type: "snapshot",
      snapshot: {
        scanCount: 1,
        lastExecutionTimeMs: 0.2,
        inputs: [true, false, false, false, false, false, false, false],
        outputs: [false, false, false, false, false, false, false, false],
        variables: [
          { kind: "scalar", dataType: "BOOL", value: true },
          {
            kind: "functionBlock",
            inputs: [{ dataType: "BOOL", value: true }],
            outputs: [{ dataType: "BOOL", value: false }],
          },
        ],
        forced: [0],
        annotations: {
          1: [
            { values: [{ dataType: "BOOL", value: true }] },
            { values: [{ dataType: "INT", value: 2 }] },
          ],
        },
      },
    },
  ];
  expect(JSON.parse(JSON.stringify(commands))).toStrictEqual(commands);
  expect(JSON.parse(JSON.stringify(events))).toStrictEqual(events);
});

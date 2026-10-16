import { expect, expectTypeOf, it } from "vitest";
import type { Diagnostic, DiagnosticArgs, DiagnosticCode, SourceSpan } from "./index.js";

const examples = {
  "lex.unterminated-comment": {},
  "lex.invalid-character": { character: "@" },
  "lex.malformed-direct-address": { address: "%IX0." },
  "lex.malformed-number": { literal: "16#GG" },
  "syntax.expected-token": { expected: ";", found: "END_PROGRAM" },
  "syntax.expected-identifier": { found: ":" },
  "syntax.reserved-identifier": { name: "IF" },
  "syntax.assignment-operator": {},
  "syntax.unexpected-eof": {},
  "syntax.missing-end": { expected: "END_IF" },
  "decl.unknown-type": { name: "STRING" },
  "decl.duplicate": { name: "Counter" },
  "decl.name-collision": { name: "ABS", kind: "function" },
  "decl.direct-address-type": { name: "Counter", type: "INT" },
  "decl.at-multiple-names": {},
  "decl.address-out-of-range": { address: "%IX1.0" },
  "decl.nonconstant-initializer": { name: "Counter" },
  "decl.fb-initializer": { name: "Timer" },
  "name.undeclared": { name: "Missing" },
  "type.invalid-constant": {},
  "type.case-label-not-constant": {},
  "fb.duplicate-input": { name: "Timer", member: "IN" },
  "type.assign-mismatch": { from: "REAL", to: "INT", hint: "explicit-conversion" },
  "type.operand-mismatch": { operator: "+", left: "BOOL", right: "INT" },
  "type.condition-not-bool": { statement: "WHILE" },
  "type.case-selector-not-integer": { type: "REAL" },
  "type.case-label-not-integer": { type: "BOOL" },
  "type.for-variable-not-integer": { name: "Index", type: "REAL" },
  "type.for-bound-not-integer": { bound: "step", type: "LREAL" },
  "flow.exit-outside-loop": {},
  "fb.not-function-block": { name: "Counter" },
  "fb.unknown-member": { name: "Timer", member: "MISSING" },
  "fb.output-not-writable": { name: "Timer", member: "Q" },
  "fb.instance-as-value": { name: "Timer" },
  "fb.call-in-expression": { name: "Timer" },
  "call.unknown-function": { name: "MISSING" },
  "call.argument-count": { name: "LIMIT", min: 3, max: 3, found: 2 },
  "call.argument-type": { name: "ABS", index: 0, expected: ["INT", "REAL"], found: "BOOL" },
  "runtime.division-by-zero": {},
  "runtime.watchdog": { limit: 10000 },
  "runtime.for-by-zero": {},
} satisfies DiagnosticArgs;

it("defines a serializable argument shape for every diagnostic code", () => {
  expectTypeOf<keyof typeof examples>().toEqualTypeOf<DiagnosticCode>();
  for (const args of Object.values(examples)) {
    expect(JSON.parse(JSON.stringify(args))).toStrictEqual(args);
  }
});

it("preserves code/argument correlation when narrowing the union", () => {
  function assignmentHint(diagnostic: Diagnostic): string | undefined {
    if (diagnostic.code === "type.assign-mismatch") {
      expectTypeOf(diagnostic.args).toEqualTypeOf<DiagnosticArgs["type.assign-mismatch"]>();
      return diagnostic.args.hint;
    }
    if (diagnostic.code === "runtime.watchdog") {
      expectTypeOf(diagnostic.args.limit).toEqualTypeOf<number>();
    }
    return undefined;
  }

  const span: SourceSpan = { line: 2, column: 3, endLine: 2, endColumn: 8 };
  const diagnostic: Diagnostic = {
    code: "type.assign-mismatch",
    severity: "warning",
    span,
    args: examples["type.assign-mismatch"],
  };
  expect(assignmentHint(diagnostic)).toBe("explicit-conversion");
  expect(JSON.parse(JSON.stringify(diagnostic))).toStrictEqual(diagnostic);
  expect(
    assignmentHint({ code: "runtime.watchdog", severity: "error", args: { limit: 1 } }),
  ).toBeUndefined();

  const withoutHint: Diagnostic<"type.assign-mismatch"> = {
    code: "type.assign-mismatch",
    severity: "error",
    args: { from: "REAL", to: "INT" },
  };
  expect(assignmentHint(withoutHint)).toBeUndefined();
});

it("supports unary operands and bounded or variadic argument counts", () => {
  const unary: Diagnostic<"type.operand-mismatch"> = {
    code: "type.operand-mismatch",
    severity: "error",
    args: { operator: "NOT", left: "REAL", right: null },
  };
  const variadic: Diagnostic<"call.argument-count"> = {
    code: "call.argument-count",
    severity: "error",
    args: { name: "MIN", min: 2, max: null, found: 1 },
  };
  expect(JSON.parse(JSON.stringify([unary, variadic]))).toStrictEqual([unary, variadic]);
});

it("accepts shared readonly nonempty lists of expected argument types", () => {
  const expected = ["INT", "REAL"] as const;
  const diagnostic: Diagnostic<"call.argument-type"> = {
    code: "call.argument-type",
    severity: "error",
    args: { name: "ABS", index: 0, expected, found: "BOOL" },
  };
  expect(diagnostic.args.expected).toBe(expected);
  expect(JSON.parse(JSON.stringify(diagnostic))).toStrictEqual(diagnostic);
  expectTypeOf<DiagnosticArgs["call.argument-type"]["expected"]>().toExtend<
    readonly [unknown, ...unknown[]]
  >();
});

it("rejects invalid codes and argument shapes during pnpm typecheck", () => {
  // tsc checks these directives; Vitest alone does not typecheck test files.
  // @ts-expect-error Only documented codes are accepted.
  const unknown: Diagnostic = { code: "runtime.example", severity: "error", args: {} };
  // @ts-expect-error The watchdog requires its numeric limit.
  const missing: Diagnostic = { code: "runtime.watchdog", severity: "error", args: {} };
  // @ts-expect-error An empty-argument code rejects extra keys.
  const extra: Diagnostic = {
    code: "runtime.division-by-zero",
    severity: "error",
    args: { limit: 1 },
  };
  const wrongType: Diagnostic = {
    code: "runtime.watchdog",
    severity: "error",
    // @ts-expect-error Argument types are fixed per code.
    args: { limit: "10" },
  };
  const crossed: Diagnostic = {
    code: "syntax.expected-token",
    severity: "error",
    // @ts-expect-error Arguments from another valid code cannot be paired with this code.
    args: { name: "x" },
  };
  const incomplete: Diagnostic = {
    code: "type.assign-mismatch",
    severity: "error",
    // @ts-expect-error Both from and to are required even though hint is optional.
    args: { from: "INT" },
  };
  const messageHint: DiagnosticArgs["type.assign-mismatch"] = {
    from: "REAL",
    to: "INT",
    // @ts-expect-error Hints are stable identifiers, not user-facing text.
    hint: "Use a conversion",
  };
  // @ts-expect-error DiagnosticSeverity is closed.
  const severity: Diagnostic = { code: "syntax.unexpected-eof", severity: "info", args: {} };
  const subset: Diagnostic<"runtime.watchdog" | "name.undeclared"> = {
    code: "runtime.watchdog",
    severity: "error",
    // @ts-expect-error A union of selected codes still preserves their argument correlation.
    args: { name: "x" },
  };
  const emptyExpected: Diagnostic<"call.argument-type"> = {
    code: "call.argument-type",
    severity: "error",
    args: {
      name: "ABS",
      index: 0,
      // @ts-expect-error At least one accepted argument type is required.
      expected: [],
      found: "BOOL",
    },
  };
  expect([
    unknown,
    missing,
    extra,
    wrongType,
    crossed,
    incomplete,
    messageHint,
    severity,
    subset,
    emptyExpected,
  ]).toHaveLength(10);
});

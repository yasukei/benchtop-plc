import { expect, expectTypeOf, it } from "vitest";
import type { Diagnostic, DiagnosticArgs, DiagnosticCode, SourceSpan } from "./index.js";

const examples = {
  "namespace.unknown": { name: "A.Motor" },
  "namespace.ambiguous": { name: "A.Motor" },
  "namespace.internal": { name: "A.Motor" },
  "namespace.internal-global": { name: "A.Motor" },
  "interface.unknown": { name: "I" },
  "interface.cycle": { name: "I" },
  "interface.signature": { name: "Run" },
  "interface.unimplemented": { name: "Run" },
  "interface.lifetime": {},
  "interface.assignment-attempt": {},
  "inheritance.unknown-base": { name: "Motor" },
  "inheritance.base-kind": { name: "Motor" },
  "inheritance.cycle": { name: "Motor" },
  "inheritance.final-base": { name: "Motor" },
  "inheritance.member-collision": { name: "Motor" },
  "inheritance.override-required": { name: "Motor" },
  "inheritance.override-missing": { name: "Motor" },
  "inheritance.override-private": { name: "Motor" },
  "inheritance.override-final": { name: "Motor" },
  "inheritance.override-access": { name: "Motor" },
  "inheritance.override-signature": { name: "Motor" },
  "inheritance.abstract-instance": { name: "Motor" },
  "inheritance.abstract-method": { name: "Motor" },
  "inheritance.abstract-private": { name: "Motor" },
  "inheritance.abstract-unimplemented": { name: "Motor" },
  "inheritance.abstract-body": {},
  "inheritance.modifier-conflict": {},
  "inheritance.super-context": {},
  "inheritance.super-method": { name: "Motor" },
  "inheritance.super-body": {},
  "decl.retention-conflict": {},
  "decl.retention-section": {},
  "decl.retention-function": {},
  "decl.retention-constant": {},
  "decl.retention-address": {},

  "global.not-found": { name: "g" },
  "global.type-mismatch": { name: "g" },
  "global.constant-mismatch": { name: "g" },
  "global.external-initializer": { name: "g" },

  "config.configuration-count": {},
  "config.resource-count": {},
  "config.task-count": {},
  "config.no-instances": {},
  "config.instance-limit": {},
  "config.name-collision": { name: "TON" },
  "config.unknown-task": { name: "Missing" },
  "config.missing-task": { name: "A" },
  "config.program-type": { name: "Counter" },
  "config.interval": {},
  "config.priority": {},
  "config.task-trigger": {},
  "config.single": {},
  "config.connection-parameter": { name: "Start" },
  "config.connection-direction": { name: "Start" },
  "config.connection-duplicate": { name: "Start" },
  "config.connection-target": { name: "Start" },
  "config.task-parameter": { name: "SINGLE" },
  "runtime.halted": {},
  "runtime.not-halted": {},
  "runtime.configured-cycle": {},

  "project.invalid-xml": {},
  "project.missing": { path: "project/types" },
  "project.unsupported": { path: "project/types/dataTypes" },
  "runtime.null-reference": {},
  "type.invalid-reference-target": {},
  "type.reference-initializer": {},
  "project.invalid": { path: "project/task/@interval" },
  "project.dropped-data": { name: "https://vendor.example/data" },
  "project.stale-source": {},
  "lex.unterminated-comment": {},
  "lex.unterminated-string": {},
  "lex.invalid-string-escape": {},
  "lex.invalid-string-character": {},
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
  "decl.type-cycle": { name: "Node" },
  "decl.structure-member-type": { name: "TON" },
  "decl.fb-array-form": { form: "named" },
  "decl.duplicate": { name: "Counter" },
  "decl.name-collision": { name: "ABS", kind: "function" },
  "decl.direct-address-type": { name: "Counter", type: "INT" },
  "decl.temp-address": {},
  "decl.parameter-address": {},
  "decl.at-multiple-names": {},
  "decl.output-overlap": { address: "%QW0", other: "%QB0" },
  "decl.address-out-of-range": { address: "%IX1.0" },
  "decl.nonconstant-initializer": { name: "Counter" },
  "decl.fb-initializer": { name: "Timer" },
  "decl.constant-section": { section: "VAR_INPUT" },
  "decl.constant-type": {},
  "decl.constant-address": {},
  "decl.constant-not-writable": { name: "N" },
  "decl.constant-order": { name: "N" },
  "decl.open-array-section": {},
  "decl.in-out-initializer": { name: "n" },
  "pou.duplicate": { name: "Compute" },
  "pou.name-collision": { name: "TON" },
  "pou.program-count": { found: 0 },
  "pou.unsupported-kind": { name: "Block" },
  "pou.invalid-section": { section: "VAR_TEMP", kind: "function" },
  "pou.direct-address": {},
  "pou.function-block-in-function": {},
  "access.duplicate": {},
  "access.invalid-section": {},
  "access.hidden": { name: "M" },
  "class.body": {},
  "class.not-callable": { name: "valve" },
  "method.invalid-owner": {},
  "method.name-collision": { name: "M" },
  "method.unknown": { name: "M" },
  "method.instance-in-out": { name: "p" },
  "method.this-outside": {},
  "method.this-call": {},
  "pou.recursion": { name: "Compute" },
  "call.program": { name: "Main" },
  "call.no-result": { name: "Compute" },
  "call.in-out-variable": {},
  "call.in-out-type": { from: "DINT", to: "INT" },
  "call.missing-in-out": { name: "Swap", parameter: "A" },
  "call.formal-required": { name: "Compute" },
  "name.undeclared": { name: "Missing" },
  "type.unknown-structure-member": { type: { kind: "named", name: "Point" }, member: "z" },
  "type.not-array": { type: "INT" },
  "type.array-index-count": { expected: 2, found: 1 },
  "type.array-index-not-integer": { type: "REAL" },
  "type.array-initializer-required": {
    type: { kind: "array", dimensions: [{ lower: 1, upper: 3 }], element: "INT" },
  },
  "type.invalid-bit-access": { type: "WORD", bit: 16 },
  "type.portability": { function: "DWORD_TO_REAL" },
  "type.invalid-constant": {},
  "type.case-label-not-constant": {},
  "fb.invalid-instance-section": { name: "Timer" },
  "fb.duplicate-input": { name: "Timer", member: "IN" },
  "fb.no-matching-variant": { name: "Counter", types: ["LINT", "ULINT"] },
  "type.assign-mismatch": { from: "REAL", to: "INT", hint: "explicit-conversion" },
  "type.operand-mismatch": { operator: "+", left: "BOOL", right: "INT" },
  "type.condition-not-bool": { statement: "WHILE" },
  "type.case-selector-not-integer": { type: "REAL" },
  "type.case-label-not-integer": { type: "BOOL" },
  "type.for-variable-not-integer": { name: "Index", type: "REAL" },
  "type.for-variable-subrange": { name: "p", type: { kind: "named", name: "Percent" } },
  "type.for-bound-not-integer": { bound: "step", type: "LREAL" },
  "flow.exit-outside-loop": {},
  "fb.not-function-block": { name: "Counter" },
  "fb.unknown-member": { name: "Timer", member: "MISSING" },
  "fb.output-not-writable": { name: "Timer", member: "Q" },
  "fb.instance-as-value": { name: "Timer" },
  "fb.unsupported-call": { name: "Timer" },
  "fb.call-in-expression": { name: "Timer" },
  "call.unknown-function": { name: "MISSING" },
  "call.invalid-parameter": { name: "SPLIT_DATE", parameter: "YEAR" },
  "call.argument-count": { name: "LIMIT", min: 3, max: 3, found: 2 },
  "call.argument-type": { name: "ABS", index: 0, expected: ["INT", "REAL"], found: "BOOL" },
  "runtime.index-out-of-range": { index: 6, lower: 1, upper: 5 },
  "runtime.subrange-violation": { value: 120, lower: 0, upper: 100 },
  "type.ambiguous-enumeration": { name: "Red" },
  "runtime.load-failed": {},
  "runtime.invalid-value": {},
  "runtime.division-by-zero": {},
  "runtime.watchdog": { limit: 10000 },
  "runtime.for-by-zero": {},
  "runtime.debug-target": {},
  "runtime.debug-type-mismatch": { from: "BOOL", to: "INT" },
  "runtime.debug-value": {},
  "runtime.write-input-mapped": { name: "input" },
  "runtime.write-connected-input": { name: "A.Start" },
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

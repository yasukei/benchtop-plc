import type { SourceSpan } from "./source.js";
import type { BinaryOperator, FunctionBlockType, UnaryOperator } from "./ir.js";
import type { DataType } from "./values.js";

/** An empty object with no argument keys (unlike TypeScript's permissive `{}`). */
type NoArguments = Record<string, never>;

/** A localizable suggestion identifier, never a preformatted message. */
export type AssignmentHint = "explicit-conversion";

/** Stable code-to-argument contract. See docs/diagnostics.md for field semantics. */
export interface DiagnosticArgs {
  "project.invalid-xml": NoArguments;
  "project.missing": { path: string };
  "project.unsupported": { path: string };
  "project.invalid": { path: string };
  "project.dropped-data": { name: string };
  "project.stale-source": NoArguments;
  "lex.unterminated-comment": NoArguments;
  "lex.invalid-character": { character: string };
  "lex.malformed-direct-address": { address: string };
  "lex.malformed-number": { literal: string };

  "syntax.expected-token": { expected: string; found: string };
  "syntax.expected-identifier": { found: string };
  "syntax.reserved-identifier": { name: string };
  "syntax.assignment-operator": NoArguments;
  "syntax.unexpected-eof": NoArguments;
  "syntax.missing-end": { expected: `END_${string}` };

  "decl.unknown-type": { name: string };
  "decl.duplicate": { name: string };
  "decl.name-collision": { name: string; kind: "type" | "function" };
  "decl.direct-address-type": { name: string; type: DataType | FunctionBlockType };
  "decl.at-multiple-names": NoArguments;
  "decl.address-out-of-range": { address: string };
  "decl.nonconstant-initializer": { name: string };
  "decl.fb-initializer": { name: string };

  "name.undeclared": { name: string };
  "type.invalid-bit-access": { type: DataType; bit: number };
  "type.portability": { name: string };
  "type.invalid-constant": NoArguments;
  "type.case-label-not-constant": NoArguments;
  "fb.duplicate-input": { name: string; member: string };
  "type.assign-mismatch": { from: DataType; to: DataType; hint?: AssignmentHint };
  "type.operand-mismatch": {
    operator: UnaryOperator | BinaryOperator;
    left: DataType;
    right: DataType | null;
  };
  "type.condition-not-bool": { statement: "IF" | "ELSIF" | "WHILE" | "REPEAT" };
  "type.case-selector-not-integer": { type: DataType };
  "type.case-label-not-integer": { type: DataType };
  "type.for-variable-not-integer": { name: string; type: DataType };
  "type.for-bound-not-integer": { bound: "from" | "to" | "step"; type: DataType };
  "flow.exit-outside-loop": NoArguments;
  "fb.not-function-block": { name: string };
  "fb.unknown-member": { name: string; member: string };
  "fb.output-not-writable": { name: string; member: string };
  "fb.instance-as-value": { name: string };
  "fb.unsupported-call": { name: string };
  "fb.call-in-expression": { name: string };
  "call.unknown-function": { name: string };
  "call.invalid-parameter": { name: string; parameter: string };
  "call.argument-count": { name: string; min: number; max: number | null; found: number };
  "call.argument-type": {
    name: string;
    index: number;
    expected: readonly [DataType, ...DataType[]];
    found: DataType;
  };

  "runtime.invalid-value": NoArguments;
  "runtime.division-by-zero": NoArguments;
  "runtime.watchdog": { limit: number };
  "runtime.for-by-zero": NoArguments;
  "runtime.debug-target": NoArguments;
  "runtime.debug-type-mismatch": { from: DataType; to: DataType };
  "runtime.debug-value": NoArguments;
  "runtime.write-input-mapped": { name: string };
}

/** Expected debug command rejections; these never latch a PLC execution fault. */
export type CommandRejectionCode =
  | "runtime.debug-target"
  | "runtime.debug-type-mismatch"
  | "runtime.debug-value"
  | "runtime.write-input-mapped";

export type DiagnosticCode = keyof DiagnosticArgs;
export type DiagnosticSeverity = "error" | "warning";

/** Mapping before indexing preserves the correlation between each code and its arguments. */
export type Diagnostic<C extends DiagnosticCode = DiagnosticCode> = {
  [K in C]: {
    code: K;
    severity: DiagnosticSeverity;
    span?: SourceSpan;
    args: DiagnosticArgs[K];
  };
}[C];

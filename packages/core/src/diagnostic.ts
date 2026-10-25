import type { SourceSpan } from "./source.js";
import type { BinaryOperator, UnaryOperator } from "./ir.js";
import type { TypeDescriptor } from "./types.js";

/** An empty object with no argument keys (unlike TypeScript's permissive `{}`). */
type NoArguments = Record<string, never>;

/** A localizable suggestion identifier, never a preformatted message. */
export type AssignmentHint = "explicit-conversion";

/** Stable code-to-argument contract. See docs/diagnostics.md for field semantics. */
export interface DiagnosticArgs {
  "namespace.unknown": { name: string };
  "namespace.ambiguous": { name: string };
  "namespace.internal": { name: string };
  "namespace.internal-global": { name: string };
  "interface.unknown": { name: string };
  "interface.cycle": { name: string };
  "interface.signature": { name: string };
  "interface.unimplemented": { name: string };
  "interface.lifetime": NoArguments;
  "interface.assignment-attempt": NoArguments;
  "inheritance.unknown-base": { name: string };
  "inheritance.base-kind": { name: string };
  "inheritance.cycle": { name: string };
  "inheritance.final-base": { name: string };
  "inheritance.member-collision": { name: string };
  "inheritance.override-required": { name: string };
  "inheritance.override-missing": { name: string };
  "inheritance.override-private": { name: string };
  "inheritance.override-final": { name: string };
  "inheritance.override-access": { name: string };
  "inheritance.override-signature": { name: string };
  "inheritance.abstract-instance": { name: string };
  "inheritance.abstract-method": { name: string };
  "inheritance.abstract-private": { name: string };
  "inheritance.abstract-unimplemented": { name: string };
  "inheritance.abstract-body": NoArguments;
  "inheritance.modifier-conflict": NoArguments;
  "inheritance.super-context": NoArguments;
  "inheritance.super-method": { name: string };
  "inheritance.super-body": NoArguments;
  "class.body": NoArguments;
  "class.not-callable": { name: string };
  "access.duplicate": NoArguments;
  "access.invalid-section": NoArguments;
  "access.hidden": { name: string };
  "method.invalid-owner": NoArguments;
  "method.name-collision": { name: string };
  "method.unknown": { name: string };
  "method.instance-in-out": { name: string };
  "method.this-outside": NoArguments;
  "method.this-call": NoArguments;
  "project.invalid-xml": NoArguments;
  "project.missing": { path: string };
  "project.unsupported": { path: string };
  "project.invalid": { path: string };
  "project.dropped-data": { name: string };
  "project.stale-source": NoArguments;
  "lex.unterminated-comment": NoArguments;
  "lex.unterminated-string": NoArguments;
  "lex.invalid-string-escape": NoArguments;
  "lex.invalid-string-character": NoArguments;
  "lex.invalid-character": { character: string };
  "lex.malformed-direct-address": { address: string };
  "lex.malformed-number": { literal: string };

  "syntax.expected-token": { expected: string; found: string };
  "syntax.expected-identifier": { found: string };
  "syntax.reserved-identifier": { name: string };
  "syntax.assignment-operator": NoArguments;
  "syntax.unexpected-eof": NoArguments;
  "syntax.missing-end": { expected: `END_${string}` };

  "decl.retention-conflict": NoArguments;
  "decl.retention-section": NoArguments;
  "decl.retention-function": NoArguments;
  "decl.retention-constant": NoArguments;
  "decl.retention-address": NoArguments;
  "decl.unknown-type": { name: string };
  "decl.type-cycle": { name: string };
  "decl.structure-member-type": { name: string };
  "decl.fb-array-form": { form: "named" | "nested" };
  "decl.duplicate": { name: string };
  "decl.name-collision": { name: string; kind: "type" | "function" };
  "decl.direct-address-type": { name: string; type: string };
  "decl.temp-address": NoArguments;
  "decl.parameter-address": NoArguments;
  "decl.at-multiple-names": NoArguments;
  "decl.output-overlap": { address: string; other: string };
  "decl.address-out-of-range": { address: string };
  "decl.nonconstant-initializer": { name: string };
  "decl.fb-initializer": { name: string };
  "decl.constant-section": { section: string };
  "decl.constant-type": NoArguments;
  "decl.constant-address": NoArguments;
  "decl.constant-not-writable": { name: string };
  "decl.constant-order": { name: string };
  "decl.open-array-section": NoArguments;
  "decl.in-out-initializer": { name: string };
  "global.not-found": { name: string };
  "global.type-mismatch": { name: string };
  "global.constant-mismatch": { name: string };
  "global.external-initializer": { name: string };
  "config.configuration-count": NoArguments;
  "config.resource-count": NoArguments;
  "config.task-count": NoArguments;
  "config.no-instances": NoArguments;
  "config.instance-limit": NoArguments;
  "config.name-collision": { name: string };
  "config.unknown-task": { name: string };
  "config.missing-task": { name: string };
  "config.program-type": { name: string };
  "config.interval": NoArguments;
  "config.priority": NoArguments;
  "config.task-trigger": NoArguments;
  "config.single": NoArguments;
  "config.connection-parameter": { name: string };
  "config.connection-direction": { name: string };
  "config.connection-duplicate": { name: string };
  "config.connection-target": { name: string };
  "config.task-parameter": { name: string };
  "runtime.configured-cycle": NoArguments;
  "pou.duplicate": { name: string };
  "pou.name-collision": { name: string };
  "pou.program-count": { found: number };
  "pou.unsupported-kind": { name: string };
  "pou.invalid-section": { section: string; kind: string };
  "pou.direct-address": NoArguments;
  "pou.function-block-in-function": NoArguments;
  "pou.recursion": { name: string };

  "type.ambiguous-enumeration": { name: string };
  "name.undeclared": { name: string };
  "type.unknown-structure-member": { type: TypeDescriptor; member: string };
  "type.not-array": { type: TypeDescriptor };
  "type.array-index-count": { expected: number; found: number };
  "type.array-index-not-integer": { type: TypeDescriptor };
  "type.array-initializer-required": { type: TypeDescriptor };
  "type.invalid-bit-access": { type: TypeDescriptor; bit: number };
  "type.portability": { function: string };
  "type.invalid-constant": NoArguments;
  "type.case-label-not-constant": NoArguments;
  "fb.invalid-instance-section": { name: string };
  "fb.duplicate-input": { name: string; member: string };
  "fb.no-matching-variant": { name: string; types: readonly TypeDescriptor[] };
  "type.assign-mismatch": { from: TypeDescriptor; to: TypeDescriptor; hint?: AssignmentHint };
  "type.operand-mismatch": {
    operator: UnaryOperator | BinaryOperator;
    left: TypeDescriptor;
    right: TypeDescriptor | null;
  };
  "type.condition-not-bool": { statement: "IF" | "ELSIF" | "WHILE" | "REPEAT" };
  "type.case-selector-not-integer": { type: TypeDescriptor };
  "type.case-label-not-integer": { type: TypeDescriptor };
  "type.for-variable-not-integer": { name: string; type: TypeDescriptor };
  "type.for-variable-subrange": { name: string; type: TypeDescriptor };
  "type.for-bound-not-integer": { bound: "from" | "to" | "step"; type: TypeDescriptor };
  "flow.exit-outside-loop": NoArguments;
  "fb.not-function-block": { name: string };
  "fb.unknown-member": { name: string; member: string };
  "fb.output-not-writable": { name: string; member: string };
  "fb.instance-as-value": { name: string };
  "fb.unsupported-call": { name: string };
  "fb.call-in-expression": { name: string };
  "call.unknown-function": { name: string };
  "call.program": { name: string };
  "call.no-result": { name: string };
  "call.in-out-variable": NoArguments;
  "call.in-out-type": { from: TypeDescriptor; to: TypeDescriptor };
  "call.missing-in-out": { name: string; parameter: string };
  "call.formal-required": { name: string };
  "call.invalid-parameter": { name: string; parameter: string };
  "call.argument-count": { name: string; min: number; max: number | null; found: number };
  "call.argument-type": {
    name: string;
    index: number;
    expected: readonly [TypeDescriptor, ...TypeDescriptor[]];
    found: TypeDescriptor;
  };

  "runtime.null-reference": NoArguments;
  "type.invalid-reference-target": NoArguments;
  "type.reference-initializer": NoArguments;
  "runtime.index-out-of-range": { index: number | string; lower: number; upper: number };
  "runtime.subrange-violation": {
    value: number | string;
    lower: number | string;
    upper: number | string;
  };
  "runtime.invalid-value": NoArguments;
  "runtime.division-by-zero": NoArguments;
  "runtime.watchdog": { limit: number };
  "runtime.for-by-zero": NoArguments;
  "runtime.debug-target": NoArguments;
  "runtime.debug-type-mismatch": { from: TypeDescriptor; to: TypeDescriptor };
  "runtime.debug-value": NoArguments;
  "runtime.write-input-mapped": { name: string };
  "runtime.write-connected-input": { name: string };
}

/** Expected debug command rejections; these never latch a PLC execution fault. */
export type CommandRejectionCode =
  | "runtime.configured-cycle"
  | "runtime.debug-target"
  | "runtime.debug-type-mismatch"
  | "runtime.debug-value"
  | "runtime.write-input-mapped"
  | "runtime.write-connected-input";

export type DiagnosticCode = keyof DiagnosticArgs;
export type DiagnosticSeverity = "error" | "warning";

/** Mapping before indexing preserves the correlation between each code and its arguments. */
export type Diagnostic<C extends DiagnosticCode = DiagnosticCode> = {
  [K in C]: {
    code: K;
    severity: DiagnosticSeverity;
    /** Source POU's spelling; absent for project-level errors or unknown headers. */
    pou?: string;
    /** Source metadata for runtime faults in configuration parameter transfers. */
    sourceKind?: "dataType" | "pou" | "configuration";
    sourceIndex?: number;
    task?: string;
    /** Canonical dotted path of the active function block instance. */
    instance?: string;
    span?: SourceSpan;
    args: DiagnosticArgs[K];
  };
}[C];

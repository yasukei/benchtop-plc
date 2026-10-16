import type { Diagnostic, SourceSpan } from "@benchtop-plc/core";

/** Internal control flow only; public entry points return diagnostic data. */
export class FrontendError extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.code);
  }
}

export function joinedSpan(first: SourceSpan, last: SourceSpan): SourceSpan {
  return {
    line: first.line,
    column: first.column,
    endLine: last.endLine,
    endColumn: last.endColumn,
  };
}

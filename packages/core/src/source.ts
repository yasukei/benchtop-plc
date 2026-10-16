/** One-based line/column positions; the end position is exclusive. */
export interface SourceSpan {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface SourceNode {
  span: SourceSpan;
}

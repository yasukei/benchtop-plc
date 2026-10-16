import type { Diagnostic } from "./diagnostic.js";
import type { IoBit, ProgramIR, VariableId } from "./ir.js";
import type { SourceSpan } from "./source.js";
import type { TypedValue } from "./values.js";

export type RuntimeState = "STOP" | "RUN" | "ESTOP" | "FAULT";

export type UiToRuntimeMessage =
  | { type: "load"; ir: ProgramIR }
  | { type: "run" }
  | { type: "stop" }
  | { type: "step" }
  | { type: "coldReset" }
  | { type: "setCycle"; ms: number }
  | { type: "setInput"; bit: IoBit; value: boolean }
  | { type: "force"; variable: VariableId; value: TypedValue | null }
  | { type: "write"; variable: VariableId; value: TypedValue }
  | { type: "estop"; active: boolean };

/** Bit n corresponds to %IX0.n or %QX0.n. */
export type IoImage = [boolean, boolean, boolean, boolean, boolean, boolean, boolean, boolean];

export type VariableSnapshot =
  | (TypedValue & { kind: "scalar" })
  | { kind: "functionBlock"; inputs: TypedValue[]; outputs: TypedValue[] };

export interface StatementAnnotation {
  /** Full span of the assignment or FB call, independent of its position in the line's array. */
  span: SourceSpan;
  /** Last execution in this scan: one assignment result, or FB outputs in descriptor order. */
  values: TypedValue[];
}

export interface RuntimeSnapshot {
  scanCount: number;
  lastExecutionTimeMs: number;
  inputs: IoImage;
  outputs: IoImage;
  /** Aligned with the loaded program's variable table; FB ports use descriptor order. */
  variables: VariableSnapshot[];
  /** Variable IDs, encoded as an array rather than a Set for JSON transport. */
  forced: VariableId[];
  /**
   * Keyed by span.line, sorted by span.column within each line. One entry per executed
   * assignment/FB call, retaining only its last execution's values in this scan.
   * Unexecuted statements and lines with no entries are omitted; no prior-scan values remain.
   */
  annotations: Record<number, StatementAnnotation[]>;
}

export type RuntimeToUiMessage =
  | { type: "state"; state: RuntimeState }
  | { type: "snapshot"; snapshot: RuntimeSnapshot }
  | { type: "fault"; diagnostic: Diagnostic };

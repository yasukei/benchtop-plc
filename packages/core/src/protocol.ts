import type { CommandRejectionCode, Diagnostic } from "./diagnostic.js";
import type { ConfigurationIR, IoBit, ProgramIR, VariableId } from "./ir.js";
import type { SourceSpan } from "./source.js";
import type { TypedValue } from "./values.js";

export type RuntimeState = "STOP" | "RUN" | "ESTOP" | "FAULT";

export type UiToRuntimeMessage =
  | { type: "load"; ir: ConfigurationIR | ProgramIR }
  | { type: "watch"; variables: VariableId[] }
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

export interface ReferenceValue {
  kind: "reference";
  target: string | null;
}
export type InlineValue = TypedValue | ReferenceValue;
export type VariableSnapshot =
  | ReferenceValue
  | (TypedValue & { kind: "scalar" })
  | { kind: "functionBlock"; inputs: TypedValue[]; outputs: TypedValue[] };

export interface StatementAnnotation {
  /** Full span of the assignment or FB call, independent of its position in the line's array. */
  span: SourceSpan;
  /** Last execution in this scan: one assignment result, or FB outputs in descriptor order. */
  values: InlineValue[];
}

export interface RuntimeSnapshot {
  scanCount: number;
  lastExecutionTimeMs: number;
  inputs: IoImage;
  outputs: IoImage;
  /** Aligned with the loaded program's variable table; FB ports use descriptor order. */
  variables: VariableSnapshot[];
  /** When present, parallel IDs for compact snapshots with watched array leaves. */
  variableIds?: VariableId[];
  /** Variable IDs, encoded as an array rather than a Set for JSON transport. */
  forced: VariableId[];
  /**
   * Keyed by POU name, then span.line, sorted by span.column within each line. One entry per executed
   * assignment/FB call, retaining only its last execution's values in this scan.
   * The first instance of each PROGRAM supplies values. Empty POUs/lines are omitted.
   */
  annotations: Record<string, Record<number, StatementAnnotation[]>>;
}

export interface CommandRejectionMessage {
  type: "rejected";
  command: "force" | "write" | "setCycle";
  diagnostic: Diagnostic<CommandRejectionCode>;
}

export type RuntimeToUiMessage =
  | { type: "state"; state: RuntimeState }
  | { type: "snapshot"; snapshot: RuntimeSnapshot }
  | { type: "fault"; diagnostic: Diagnostic }
  | CommandRejectionMessage;

/** Scalar-only snapshots keep their original layout; composites use compact ID/value pairs. */
export function snapshotVariable(
  snapshot: RuntimeSnapshot | null | undefined,
  id: VariableId,
): VariableSnapshot | undefined {
  if (!snapshot) return undefined;
  return snapshot.variables[snapshot.variableIds ? snapshot.variableIds.indexOf(id) : id];
}

import type { CommandRejectionCode, Diagnostic } from "./diagnostic.js";
import type { ConfigurationIR, ProgramIR, VariableId } from "./ir.js";
import type { SourceSpan } from "./source.js";
import type { TypedValue } from "./values.js";

/** Complete, JSON-safe retained storage; standard-block ports occur only in block records. */
export type RetentiveRecord =
  | { kind: "leaf"; path: string; dataType: string; value: TypedValue }
  | {
      kind: "block";
      path: string;
      blockType: import("./ir.js").FunctionBlockType;
      inputs: TypedValue[];
      outputs: TypedValue[];
      state: Record<string, boolean | null>;
    };

export type RuntimeState = "STOP" | "RUN" | "ESTOP" | "FAULT";

export type UiToRuntimeMessage =
  | { type: "load"; ir: ConfigurationIR | ProgramIR; retentive?: RetentiveRecord[] }
  | { type: "watch"; variables: VariableId[] }
  | { type: "watchBodies"; bodies: BodyWatch[] }
  | { type: "run" }
  | { type: "stop" }
  | { type: "step" }
  | { type: "coldReset" }
  | { type: "warmRestart" }
  | { type: "restoreRetentive"; records: RetentiveRecord[] }
  | { type: "setCycle"; ms: number }
  | { type: "setInput"; address: string; value: TypedValue }
  | { type: "force"; variable: VariableId; value: TypedValue | null }
  | { type: "write"; variable: VariableId; value: TypedValue }
  | { type: "estop"; active: boolean };

/** Exactly 64 bytes (0–255), in ascending byte order. */
export type IoImage = number[];

export interface ReferenceValue {
  kind: "reference";
  target: string | null;
}
export type InlineValue = TypedValue | ReferenceValue;
export type VariableSnapshot =
  | ReferenceValue
  | { kind: "invalidReal"; bits: string }
  | (TypedValue & { kind: "scalar" })
  | { kind: "functionBlock"; inputs: TypedValue[]; outputs: TypedValue[] };

export interface StatementAnnotation {
  /** Full span of the assignment or FB call, independent of its position in the line's array. */
  span: SourceSpan;
  /** Last execution in the instance run: one assignment result, or FB outputs in descriptor order. */
  values: InlineValue[];
}

/** A source body and the persistent instance whose invocation supplies its values. */
export interface BodyWatch {
  pou: string;
  instance: string | null;
}

export interface AnnotatedBody extends BodyWatch {
  /** Present for a function: the immediate caller and the call expression's start line. */
  caller?: { pou: string; instance: string | null; line: number };
  /** Scheduler pass in which this body last started running. */
  scanCount: number;
  /** One entry per executed statement, sorted by column within each line. */
  lines: Record<number, StatementAnnotation[]>;
}

export interface TaskTelemetry {
  name: string;
  runCount: number;
  lastExecutionTimeMs: number;
  maxExecutionTimeMs: number;
  overruns: number;
}

export interface RuntimeSnapshot {
  /** In task declaration order; empty before load. */
  tasks: TaskTelemetry[];
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
  /** Watched bodies' latest invocations; empty bodies are omitted unless they name a function caller. */
  annotations: AnnotatedBody[];
}

export interface CommandRejectionMessage {
  type: "rejected";
  command: "force" | "write" | "setCycle";
  diagnostic: Diagnostic<CommandRejectionCode>;
}

export type RuntimeToUiMessage =
  | { type: "retentive"; records: RetentiveRecord[] }
  | { type: "retentiveRestored"; skipped: string[] }
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

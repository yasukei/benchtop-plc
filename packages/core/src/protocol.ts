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

export type RuntimeState = "STOP" | "RUN" | "ESTOP" | "FAULT" | "HALT";

export type UiToRuntimeMessage =
  | {
      type: "load";
      /** Unique per attempt within this client session; echoed only by its completion. */
      loadId: number;
      ir: ConfigurationIR | ProgramIR;
      retentive?: RetentiveRecord[];
    }
  | { type: "watch"; variables: VariableId[] }
  | { type: "watchBodies"; bodies: BodyWatch[] }
  | { type: "setBreakpoints"; breakpoints: Breakpoint[] }
  | { type: "continue" }
  | { type: "debugStep"; kind: DebugStepKind }
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

export interface Breakpoint {
  pou: string;
  line: number;
}

export type DebugStepKind = "over" | "into" | "out";

/** JSON-safe values held only by a live invocation. Aggregate names include member/index suffixes. */
export type CallValue =
  | InlineValue
  | InvalidRealValue
  | { kind: "aggregate"; elements: { name: string; value: CallValue }[] };
export interface CallVariable {
  name: string;
  value: CallValue;
  /** In-out actual: persistent storage, or a local in another frame (innermost is 0). */
  actual?: { path: string } | { frame: number; name: string };
}

/** One live invocation, ordered innermost first in a halted event. */
export interface CallFrame {
  kind: "PROGRAM" | "FUNCTION_BLOCK" | "METHOD" | "FUNCTION";
  pou: string;
  instance: string | null;
  span: SourceSpan;
  /** Present on the outermost PROGRAM invocation. */
  task?: string;
  values: CallVariable[];
  /** Function invocation caller, including the call expression line. */
  caller?: AnnotatedBody["caller"];
  annotations: Record<number, StatementAnnotation[]>;
}

export interface HaltedMessage {
  type: "halted";
  operatingState: "RUN" | "STOP";
  task: string;
  frames: CallFrame[];
}

/** Exactly 64 bytes (0–255), in ascending byte order. */
export type IoImage = number[];

export interface ReferenceValue {
  kind: "reference";
  target: string | null;
}
export type InlineValue = TypedValue | ReferenceValue;
/** Non-finite floating-point storage inspected without a program read. */
export interface InvalidRealValue {
  kind: "invalidReal";
  bits: string;
}
export type VariableSnapshot =
  | ReferenceValue
  | InvalidRealValue
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
  command: "force" | "write" | "setInput" | "setCycle" | "run" | "step" | "continue" | "debugStep";
  diagnostic: Diagnostic<CommandRejectionCode>;
}

export type RuntimeToUiMessage =
  | HaltedMessage
  | { type: "retentive"; records: RetentiveRecord[] }
  | { type: "retentiveRestored"; skipped: string[] }
  | { type: "state"; state: RuntimeState }
  | { type: "snapshot"; snapshot: RuntimeSnapshot; loadId?: number }
  | { type: "fault"; diagnostic: Diagnostic; loadId?: number }
  | CommandRejectionMessage;

/** Scalar-only snapshots keep their original layout; composites use compact ID/value pairs. */
export function snapshotVariable(
  snapshot: RuntimeSnapshot | null | undefined,
  id: VariableId,
): VariableSnapshot | undefined {
  if (!snapshot) return undefined;
  return snapshot.variables[snapshot.variableIds ? snapshot.variableIds.indexOf(id) : id];
}

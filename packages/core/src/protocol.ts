import type { Diagnostic } from "./diagnostic.js";
import type { IoBit, ProgramIR, VariableId } from "./ir.js";
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
  /** Assignment result, or FB outputs; arrays also represent repeated execution on one line. */
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
  /** One-based source line; multiple statements on a line retain separate annotations. */
  annotations: Record<number, StatementAnnotation[]>;
}

export type RuntimeToUiMessage =
  | { type: "state"; state: RuntimeState }
  | { type: "snapshot"; snapshot: RuntimeSnapshot }
  | { type: "fault"; diagnostic: Diagnostic };

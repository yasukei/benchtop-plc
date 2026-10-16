import type { SourceNode } from "./source.js";
import type { DataType, IntegerType, TypedValue, ValueByType } from "./values.js";

/** Zero-based index into ProgramIR.variables, stable for the lifetime of a loaded program. */
export type VariableId = number;
export type IoBit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface DirectAddress {
  area: "I" | "Q";
  byte: 0;
  bit: IoBit;
}

export type FunctionBlockType = "TON" | "TOF" | "TP" | "R_TRIG" | "F_TRIG" | "CTU" | "CTD";
export type StandardFunction =
  | "ABS"
  | "MIN"
  | "MAX"
  | "LIMIT"
  | "SEL"
  | "REAL_TO_INT"
  | "INT_TO_REAL"
  | "TIME_TO_INT"
  | "INT_TO_TIME"
  | "BOOL_TO_INT";

interface VariableBase extends SourceNode {
  /** Original spelling for display. */
  name: string;
  /** Upper-case ST identifier, for compilation and display lookup only. */
  key: string;
}

export type ScalarVariable = VariableBase &
  {
    [K in DataType]: {
      kind: "scalar";
      dataType: K;
      initialValue: ValueByType[K];
      address?: K extends "BOOL" ? DirectAddress : never;
    };
  }[DataType];

export interface FunctionBlockVariable extends VariableBase {
  kind: "functionBlock";
  fbType: FunctionBlockType;
  /** FBs have no user initializer; the runtime creates the standard initial state. */
  initialValue: null;
}

/** Scalar `initialValue` is already coerced (including the default). */
export type Variable = ScalarVariable | FunctionBlockVariable;

export interface ProgramIR extends SourceNode {
  kind: "program";
  name: string;
  variables: Variable[];
  body: Statement[];
}

export type LiteralExpression = SourceNode & TypedValue & { kind: "literal" };

export interface VariableReference extends SourceNode {
  kind: "variable";
  variable: VariableId;
  dataType: DataType;
}

/** Port indices address the standard FB descriptor's input or output array. */
export interface FunctionBlockMemberReference extends SourceNode {
  kind: "fbMember";
  variable: VariableId;
  port: "input" | "output";
  member: number;
  dataType: DataType;
}

export type AssignmentTarget =
  VariableReference | (FunctionBlockMemberReference & { port: "input" });

export type UnaryOperator = "+" | "-" | "NOT";
export type BinaryOperator =
  "+" | "-" | "*" | "/" | "MOD" | "AND" | "OR" | "XOR" | "=" | "<>" | "<" | ">" | "<=" | ">=";

export interface UnaryExpression extends SourceNode {
  kind: "unary";
  operator: UnaryOperator;
  operand: Expression;
  dataType: DataType;
}

export interface BinaryExpression extends SourceNode {
  kind: "binary";
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
  dataType: DataType;
}

export interface FunctionCallExpression extends SourceNode {
  kind: "functionCall";
  /** A resolved standard-function opcode; never a source identifier. */
  function: StandardFunction;
  args: Expression[];
  dataType: DataType;
}

export type Expression =
  | LiteralExpression
  | VariableReference
  | FunctionBlockMemberReference
  | UnaryExpression
  | BinaryExpression
  | FunctionCallExpression;

export interface AssignmentStatement extends SourceNode {
  kind: "assignment";
  target: AssignmentTarget;
  value: Expression;
}

export interface FunctionBlockInput extends SourceNode {
  /** Canonical upper-case input name retained for inspection. */
  name: string;
  /** Resolved input index; execution uses this rather than looking up name. */
  input: number;
  value: Expression;
}

export interface FunctionBlockCallStatement extends SourceNode {
  kind: "fbCall";
  variable: VariableId;
  inputs: FunctionBlockInput[];
}

export interface ConditionalBranch extends SourceNode {
  condition: Expression;
  body: Statement[];
}

export interface IfStatement extends SourceNode {
  kind: "if";
  /** First IF branch followed by zero or more ELSIF branches. */
  branches: [ConditionalBranch, ...ConditionalBranch[]];
  elseBody: Statement[];
}

export type CaseLabel = SourceNode &
  ({ kind: "value"; value: number } | { kind: "range"; lower: number; upper: number });

export interface CaseBranch extends SourceNode {
  labels: [CaseLabel, ...CaseLabel[]];
  body: Statement[];
}

export interface CaseStatement extends SourceNode {
  kind: "case";
  selector: Expression;
  branches: CaseBranch[];
  elseBody: Statement[];
}

export interface ForStatement extends SourceNode {
  kind: "for";
  variable: VariableReference & { dataType: IntegerType };
  from: Expression;
  to: Expression;
  /** Explicit even when the source omits BY (default 1). */
  step: Expression;
  body: Statement[];
}

export interface WhileStatement extends SourceNode {
  kind: "while";
  condition: Expression;
  body: Statement[];
}

export interface RepeatStatement extends SourceNode {
  kind: "repeat";
  body: Statement[];
  until: Expression;
}

export interface ExitStatement extends SourceNode {
  kind: "exit";
}
export interface ReturnStatement extends SourceNode {
  kind: "return";
}

export type Statement =
  | AssignmentStatement
  | FunctionBlockCallStatement
  | IfStatement
  | CaseStatement
  | ForStatement
  | WhileStatement
  | RepeatStatement
  | ExitStatement
  | ReturnStatement;

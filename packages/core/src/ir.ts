import type { SourceNode } from "./source.js";
import type {
  BitType,
  BitStringType,
  DataType,
  IntegerType,
  NumericType,
  TypedValue,
  ValueByType,
} from "./values.js";

/** Zero-based index into ProgramIR.variables, stable for the lifetime of a loaded program. */
export type VariableId = number;
export type IoBit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface DirectAddress {
  area: "I" | "Q";
  byte: 0;
  bit: IoBit;
}

export type FunctionBlockType = "TON" | "TOF" | "TP" | "R_TRIG" | "F_TRIG" | "CTU" | "CTD";
export type CalendarConversion =
  | "DT_TO_DATE"
  | "DT_TO_TOD"
  | "DT_TO_LTOD"
  | "DT_TO_LDT"
  | "LDT_TO_DT"
  | "LDT_TO_DATE"
  | "LDT_TO_TOD"
  | "LDT_TO_LTOD"
  | "TOD_TO_LTOD"
  | "LTOD_TO_TOD"
  | "DATE_TO_LDATE"
  | "LDATE_TO_DATE"
  | "LDT_TO_LDATE";
export type ConversionFunction =
  | CalendarConversion
  | {
      [A in NumericType]: `${A}_TO_${Exclude<NumericType, A>}`;
    }[NumericType]
  | { [A in BitType]: `${A}_TO_${Exclude<BitType, A>}` }[BitType]
  | `${IntegerType}_TO_${BitStringType}`
  | `${BitStringType}_TO_${IntegerType}`
  | "REAL_TO_DWORD"
  | "DWORD_TO_REAL"
  | "LREAL_TO_LWORD"
  | "LWORD_TO_LREAL"
  | "LTIME_TO_TIME"
  | "TIME_TO_LTIME"
  | `LTIME_TO_${IntegerType}`
  | `${IntegerType}_TO_LTIME`
  | `BOOL_TO_${IntegerType}`
  | `TIME_TO_${IntegerType}`
  | `${IntegerType}_TO_TIME`
  | `TO_${DataType}`;
export type TruncationFunction =
  `TRUNC_${IntegerType}` | `${"REAL" | "LREAL"}_TRUNC_${IntegerType}`;
export type BcdFunction =
  `${BitStringType}_BCD_TO_${IntegerType}` | `${IntegerType}_TO_BCD_${BitStringType}`;
export type TimeArithmeticFunction =
  | "ADD_TIME"
  | "ADD_TOD_TIME"
  | "ADD_DT_TIME"
  | "SUB_TIME"
  | "SUB_DATE_DATE"
  | "SUB_TOD_TIME"
  | "SUB_TOD_TOD"
  | "SUB_DT_TIME"
  | "SUB_DT_DT"
  | "MUL_TIME"
  | "DIV_TIME"
  | "ADD_LTIME"
  | "ADD_LTOD_LTIME"
  | "ADD_LDT_LTIME"
  | "SUB_LTIME"
  | "SUB_LDATE_LDATE"
  | "SUB_LTOD_LTIME"
  | "SUB_LTOD_LTOD"
  | "SUB_LDT_LTIME"
  | "SUB_LDT_LDT"
  | "MUL_LTIME"
  | "DIV_LTIME";
export type CalendarFunction =
  | "CONCAT_DATE_TOD"
  | "CONCAT_DATE_LTOD"
  | "CONCAT_DATE"
  | "CONCAT_TOD"
  | "CONCAT_LTOD"
  | "CONCAT_DT"
  | "CONCAT_LDT"
  | "SPLIT_DATE"
  | "SPLIT_TOD"
  | "SPLIT_LTOD"
  | "SPLIT_DT"
  | "SPLIT_LDT"
  | "DAY_OF_WEEK";
export type StandardFunction =
  | TimeArithmeticFunction
  | CalendarFunction
  | "ABS"
  | "SQRT"
  | "LN"
  | "LOG"
  | "EXP"
  | "SIN"
  | "COS"
  | "TAN"
  | "ASIN"
  | "ACOS"
  | "ATAN"
  | "ATAN2"
  | "ADD"
  | "MUL"
  | "SUB"
  | "DIV"
  | "MOD"
  | "EXPT"
  | "MOVE"
  | "SHL"
  | "SHR"
  | "ROL"
  | "ROR"
  | "AND"
  | "OR"
  | "XOR"
  | "NOT"
  | "MIN"
  | "MAX"
  | "LIMIT"
  | "SEL"
  | "MUX"
  | "GT"
  | "GE"
  | "EQ"
  | "LE"
  | "LT"
  | "NE"
  | TruncationFunction
  | BcdFunction
  | ConversionFunction;

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

/** A bit of a scalar bit-string variable; assignment preserves all other bits. */
export interface BitReference extends SourceNode {
  kind: "bit";
  variable: VariableId;
  bit: number;
  dataType: "BOOL";
}
export type AssignmentTarget =
  VariableReference | BitReference | (FunctionBlockMemberReference & { port: "input" });

export type UnaryOperator = "+" | "-" | "NOT";
export type BinaryOperator =
  | "+"
  | "-"
  | "*"
  | "/"
  | "**"
  | "MOD"
  | "AND"
  | "OR"
  | "XOR"
  | "="
  | "<>"
  | "<"
  | ">"
  | "<="
  | ">=";

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
  /** Resolved output port indices; arguments are evaluated before outputs are assigned. */
  outputs?: FunctionOutputAssignment[];
  dataType: DataType;
}

export interface FunctionOutputAssignment extends SourceNode {
  output: number;
  target: AssignmentTarget;
}

export interface FunctionCallStatement extends SourceNode {
  kind: "call";
  call: FunctionCallExpression;
}

export type Expression =
  | LiteralExpression
  | VariableReference
  | BitReference
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
  (
    | { kind: "value"; value: number | string }
    | { kind: "range"; lower: number | string; upper: number | string }
  );

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
  | FunctionCallStatement
  | FunctionBlockCallStatement
  | IfStatement
  | CaseStatement
  | ForStatement
  | WhileStatement
  | RepeatStatement
  | ExitStatement
  | ReturnStatement;

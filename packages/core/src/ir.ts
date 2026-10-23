import type { TypeDescriptor, TypeTable, InitialValue } from "./types.js";
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
/** Declaration index in the executing frame; storage mappings resolve monitored VariableIds. */
export type FrameSlot = number;
export type IoBit = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface DirectAddress {
  area: "I" | "Q";
  byte: 0;
  bit: IoBit;
}

export type CounterType = "INT" | "DINT" | "LINT" | "UDINT" | "ULINT";
export type FunctionBlockType =
  | "R_TRIG"
  | "F_TRIG"
  | "SR"
  | "RS"
  | "CTU"
  | "CTD"
  | "CTUD"
  | `${"CTU" | "CTD" | "CTUD"}_${CounterType}`
  | "TON"
  | "TOF"
  | "TP"
  | `${"TON" | "TOF" | "TP"}_${"TIME" | "LTIME"}`;
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
export type StringFunction =
  "LEN" | "LEFT" | "RIGHT" | "MID" | "CONCAT" | "INSERT" | "DELETE" | "REPLACE" | "FIND";
export type StringConversion =
  | `${Exclude<DataType, "STRING" | "WSTRING" | "CHAR" | "WCHAR">}_TO_${"STRING" | "WSTRING"}`
  | `${"STRING" | "WSTRING"}_TO_${Exclude<DataType, "STRING" | "WSTRING" | "CHAR" | "WCHAR">}`
  | "STRING_TO_WSTRING"
  | "WSTRING_TO_STRING"
  | "CHAR_TO_STRING"
  | "WCHAR_TO_WSTRING"
  | "STRING_TO_CHAR"
  | "WSTRING_TO_WCHAR"
  | "CHAR_TO_WCHAR"
  | "WCHAR_TO_CHAR"
  | "CHAR_TO_BYTE"
  | "BYTE_TO_CHAR"
  | "WCHAR_TO_WORD"
  | "WORD_TO_WCHAR";
export type ConversionFunction =
  | StringConversion
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
  | StringFunction
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
  /** Display path segments; aggregate leaves are sent only when watched or forced. */
  path?: string[];
  /** Upper-case ST identifier, for compilation and display lookup only. */
  key: string;
}

export type ScalarVariable = VariableBase &
  (
    | {
        [K in DataType]: {
          kind: "scalar";
          dataType: K;
          initialValue: ValueByType[K];
          address?: K extends "BOOL" ? DirectAddress : never;
        };
      }[DataType]
    | {
        kind: "scalar";
        dataType: Exclude<TypeDescriptor, DataType>;
        initialValue: TypedValue["value"];
        address?: never;
      }
  );

export interface FunctionBlockVariable extends VariableBase {
  kind: "functionBlock";
  fbType: FunctionBlockType;
  /** FBs have no user initializer; the runtime creates the standard initial state. */
  initialValue: null;
}

/** References start unbound; targets are established only by executing REF assignments. */
export interface ReferenceVariable extends VariableBase {
  kind: "reference";
  dataType: TypeDescriptor;
  initialValue: null;
}
export type Variable = ScalarVariable | ReferenceVariable | FunctionBlockVariable;

export interface ProgramIR extends SourceNode {
  kind: "program";
  name: string;
  variables: Variable[];
  body: Statement[];
  /** Ordered data type declarations; absent for elementary-only projects. */
  types?: TypeTable;
  /** Shared bodies; call indices address this array. Absent in a single-program IR. */
  functions?: UserFunctionIR[];
  functionBlocks?: UserFunctionBlockIR[];
  /** Declaration slots mapped to monitored storage, temporaries or user instances. */
  composites?: { name: string; path: string[]; dataType: TypeDescriptor }[];
  storage?: InstanceStorage[];
  instances?: UserFunctionBlockStorage[];
}

/** Local declaration slots are distinct from the flat monitored VariableIds. */
export interface ArrayVariable extends VariableBase {
  kind: "array";
  dataType: TypeDescriptor;
  initialValue: InitialValue[];
}
export interface StructureVariable extends Omit<ArrayVariable, "kind"> {
  kind: "structure";
}
export type LocalVariable =
  | StructureVariable
  | ArrayVariable
  | Variable
  | (VariableBase & {
      kind: "userFunctionBlock";
      block: number;
      initialValue: null;
    });
export type InstanceStorage =
  | { kind: "variable"; variable: VariableId }
  | {
      kind: "temporary";
      variable: ScalarVariable | ReferenceVariable | ArrayVariable | StructureVariable;
    }
  | { kind: "array"; dataType: TypeDescriptor; elements: InstanceStorage[] }
  | { kind: "structure"; dataType: TypeDescriptor; elements: InstanceStorage[] }
  | { kind: "instance"; instance: number }
  | { kind: "inOut" };
export interface UserFunctionBlockStorage {
  block: number;
  path: string;
  storage: InstanceStorage[];
}
export interface UserFunctionBlockIR extends SourceNode {
  name: string;
  variables: LocalVariable[];
  inputs: FrameSlot[];
  outputs: FrameSlot[];
  /** Alias slots, bound to caller storage on every invocation. */
  inOuts?: FrameSlot[];
  temporaries: FrameSlot[];
  body: Statement[];
}

export interface UserFunctionIR extends SourceNode {
  name: string;
  variables: (ScalarVariable | ReferenceVariable | ArrayVariable | StructureVariable)[];
  inputs: FrameSlot[];
  outputs: FrameSlot[];
  /** Alias slots, bound to caller storage on every invocation. */
  inOuts?: FrameSlot[];
  /** Local variable holding the result; absent for a function without a result. */
  result?: FrameSlot;
  body: Statement[];
}

export interface InOutBinding {
  variable: FrameSlot;
  actual: VariableReference | IndexReference | StructureMemberReference;
}

export interface UserFunctionCall extends SourceNode {
  kind: "userFunctionCall";
  function: number;
  /** In source order, including for formal calls. Omitted inputs keep their initial values. */
  inputs: { variable: FrameSlot; value: Expression }[];
  outputs: { variable: FrameSlot; target: AssignmentTarget }[];
  inOuts?: InOutBinding[];
  dataType: TypeDescriptor | null;
}

export type UserFunctionCallExpression = UserFunctionCall & { dataType: TypeDescriptor };

export type LiteralExpression = SourceNode & { kind: "literal" } & (
    TypedValue | { dataType: Exclude<TypeDescriptor, DataType>; value: TypedValue["value"] }
  );

export interface VariableReference extends SourceNode {
  kind: "variable";
  variable: FrameSlot;
  dataType: TypeDescriptor;
}

/** Port indices address the standard FB descriptor's input or output array. */
export interface FunctionBlockMemberReference extends SourceNode {
  kind: "fbMember";
  variable: FrameSlot;
  /** Indexed instance, resolved once before accessing ports or evaluating call inputs. */
  instance?: IndexReference;
  port: "input" | "output";
  member: number;
  dataType: TypeDescriptor;
}

/** A public scalar member; member is a slot in the shared block definition. */
export interface UserFunctionBlockMemberReference extends SourceNode {
  kind: "userFbMember";
  variable: FrameSlot;
  /** Indexed instance, resolved once before accessing ports or evaluating call inputs. */
  instance?: IndexReference;
  port: "input" | "output";
  member: number;
  dataType: TypeDescriptor;
}

/** A bit of a scalar bit-string variable; assignment preserves all other bits. */
export interface BitReference extends SourceNode {
  kind: "bit";
  variable: FrameSlot;
  bit: number;
  dataType: "BOOL";
}
export interface IndexReference extends SourceNode {
  kind: "index";
  /** Declaration name for instance bounds diagnostics. */
  instanceName?: string;
  array: StorageReference;
  indices: Expression[];
  dataType: TypeDescriptor;
}
export interface StructureMemberReference extends SourceNode {
  kind: "structureMember";
  object: StorageReference;
  member: number;
  dataType: TypeDescriptor;
}
export interface ElementBitReference extends SourceNode {
  kind: "elementBit";
  element: IndexReference | StructureMemberReference;
  bit: number;
  dataType: "BOOL";
}
export interface Dereference extends SourceNode {
  kind: "dereference";
  reference: Expression;
  dataType: TypeDescriptor;
}
export type StorageReference =
  | VariableReference
  | IndexReference
  | StructureMemberReference
  | UserFunctionBlockMemberReference
  | Dereference;
export type AssignmentTarget =
  | Dereference
  | StructureMemberReference
  | IndexReference
  | ElementBitReference
  | VariableReference
  | BitReference
  | ((FunctionBlockMemberReference | UserFunctionBlockMemberReference) & { port: "input" });

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
  dataType: TypeDescriptor;
}

export interface BinaryExpression extends SourceNode {
  kind: "binary";
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
  dataType: TypeDescriptor;
}

export interface FunctionCallExpression extends SourceNode {
  kind: "functionCall";
  /** A resolved standard-function opcode; never a source identifier. */
  function: StandardFunction;
  args: Expression[];
  /** Formal arguments retain source evaluation order despite signature ordering. */
  evaluationOrder?: number[];
  /** Resolved output port indices; arguments are evaluated before outputs are assigned. */
  outputs?: FunctionOutputAssignment[];
  dataType: TypeDescriptor;
}

export interface FunctionOutputAssignment extends SourceNode {
  output: number;
  target: AssignmentTarget;
}

export interface FunctionCallStatement extends SourceNode {
  kind: "call";
  call: FunctionCallExpression | UserFunctionCall | ArrayBoundExpression;
}

export interface ArrayBoundExpression extends SourceNode {
  kind: "arrayBound";
  array: Expression;
  /** Zero-based dimension, checked at compile time. */
  dimension: number;
  upper: boolean;
  dataType: "DINT";
}

export type Expression =
  | Dereference
  | (SourceNode & {
      kind: "referenceOf";
      target: StorageReference | FunctionBlockMemberReference;
      dataType: TypeDescriptor;
    })
  | (SourceNode & { kind: "null"; dataType: TypeDescriptor })
  | ArrayBoundExpression
  | StructureMemberReference
  | IndexReference
  | ElementBitReference
  | LiteralExpression
  | VariableReference
  | BitReference
  | FunctionBlockMemberReference
  | UserFunctionBlockMemberReference
  | UnaryExpression
  | BinaryExpression
  | UserFunctionCallExpression
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
  variable: FrameSlot;
  /** Indexed instance, resolved once before accessing ports or evaluating call inputs. */
  instance?: IndexReference;
  inputs: FunctionBlockInput[];
  outputs?: FunctionOutputAssignment[];
}

export interface UserFunctionBlockCallStatement extends SourceNode {
  inOuts?: InOutBinding[];
  kind: "userFbCall";
  variable: FrameSlot;
  /** Indexed instance, resolved once before accessing ports or evaluating call inputs. */
  instance?: IndexReference;
  inputs: FunctionBlockInput[];
  outputs?: FunctionOutputAssignment[];
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
  | UserFunctionBlockCallStatement
  | IfStatement
  | CaseStatement
  | ForStatement
  | WhileStatement
  | RepeatStatement
  | ExitStatement
  | ReturnStatement;

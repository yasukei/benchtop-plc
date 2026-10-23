import type {
  DataType,
  TypeDescriptor,
  TypeTable,
  ScalarValue,
  StandardFunction,
} from "@benchtop-plc/core";
import type {
  Expression,
  FunctionCall,
  FunctionBlockCall,
  AssignmentTarget,
  Identifier,
  Program,
} from "./ast.js";

export interface UserCallInfo {
  function: number;
  inputs: { variable: number; value: Expression; dataType: DataType }[];
  outputs: { variable: number; target: AssignmentTarget }[];
  inOuts: { variable: number; actual: AssignmentTarget }[];
  result: DataType | null;
  resultDescriptor?: TypeDescriptor;
}

export interface VariableSymbol {
  /** Index in declaration order, shared by all resolved references. */
  id: number;
  name: Identifier;
  type: string;
  descriptor?: TypeDescriptor;
  userBlock?: number;
  initialValue: ScalarValue | null;
  aggregateValues?: import("@benchtop-plc/core").InitialValue[];
}

export interface ExpressionInfo {
  dataType: DataType;
  descriptor?: TypeDescriptor;
  /** Untyped arithmetic is folded exactly before materialization at its typed position. */
  untyped?: boolean;
  constant?: ScalarValue;
}

export interface ResolvedReference {
  variable: number;
  port?: "input" | "output";
  member?: number;
  bit?: number;
  userBlock?: boolean;
  structure?: boolean;
}

/** Semantic side tables use AST object identity; they are compiler-local, not wire IR. */
export interface CheckedProgram {
  ast: Program;
  types: TypeTable;
  symbols: readonly VariableSymbol[];
  expressions: ReadonlyMap<Expression, ExpressionInfo>;
  references: ReadonlyMap<Identifier, ResolvedReference>;
  arrayBounds: ReadonlyMap<FunctionCall, { array: Expression; dimension: number; upper: boolean }>;
  functions: ReadonlyMap<FunctionCall, StandardFunction>;
  functionArguments: ReadonlyMap<FunctionCall, readonly Expression[]>;
  userCalls: ReadonlyMap<FunctionCall | FunctionBlockCall, UserCallInfo>;
  blockInputTypes: ReadonlyMap<Identifier, DataType>;
  blockInOuts: ReadonlyMap<FunctionCall | FunctionBlockCall, UserCallInfo["inOuts"]>;
  result?: VariableSymbol;
}

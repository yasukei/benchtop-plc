import type { DataType, ScalarValue, StandardFunction } from "@benchtop-plc/core";
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
  result: DataType | null;
}

export interface VariableSymbol {
  /** Index in declaration order, shared by all resolved references. */
  id: number;
  name: Identifier;
  type: string;
  userBlock?: number;
  initialValue: ScalarValue | null;
}

export interface ExpressionInfo {
  dataType: DataType;
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
}

/** Semantic side tables use AST object identity; they are compiler-local, not wire IR. */
export interface CheckedProgram {
  ast: Program;
  symbols: readonly VariableSymbol[];
  expressions: ReadonlyMap<Expression, ExpressionInfo>;
  references: ReadonlyMap<Identifier, ResolvedReference>;
  functions: ReadonlyMap<FunctionCall, StandardFunction>;
  functionArguments: ReadonlyMap<FunctionCall, readonly Expression[]>;
  userCalls: ReadonlyMap<FunctionCall | FunctionBlockCall, UserCallInfo>;
  blockInputTypes: ReadonlyMap<Identifier, DataType>;
  result?: VariableSymbol;
}

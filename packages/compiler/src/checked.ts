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
  method?: { block: number; receiver?: AssignmentTarget; static?: true };
  function: number;
  inputs: { variable: number; value: Expression; dataType: DataType }[];
  outputs: { variable: number; target: AssignmentTarget }[];
  inOuts: { variable: number; actual: AssignmentTarget }[];
  result: DataType | null;
  resultDescriptor?: TypeDescriptor;
}

export interface ConstantSymbol {
  name: Identifier;
  type: DataType;
  descriptor?: TypeDescriptor;
  initializerProcessed: boolean;
  value?: ScalarValue;
}
export interface GlobalScope {
  symbols: readonly VariableSymbol[];
  constants: ReadonlyMap<string, ConstantSymbol>;
  /** Selecting argument types collected across every POU in the project. */
  bindings: Map<string, DataType[]>;
  /** Selecting argument types shared by a block body and all its methods. */
  memberBindings?: Map<string, DataType[]>;
}
export interface VariableSymbol {
  /** Index in declaration order, shared by all resolved references. */
  id: number;
  external?: string;
  name: Identifier;
  type: string;
  descriptor?: TypeDescriptor;
  userBlock?: number;
  initialValue: ScalarValue | null;
  aggregateValues?: import("@benchtop-plc/core").InitialValue[];
}

export interface ExpressionInfo {
  nullReference?: boolean;
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
  memberCount?: number;
  superCalls: ReadonlyMap<FunctionCall | FunctionBlockCall, number>;
  types: TypeTable;
  symbols: readonly VariableSymbol[];
  constants: ReadonlyMap<string, ConstantSymbol>;
  expressions: ReadonlyMap<Expression, ExpressionInfo>;
  references: ReadonlyMap<Identifier, ResolvedReference>;
  arrayBounds: ReadonlyMap<FunctionCall, { array: Expression; dimension: number; upper: boolean }>;
  functions: ReadonlyMap<FunctionCall, StandardFunction>;
  functionArguments: ReadonlyMap<FunctionCall, readonly Expression[]>;
  userCalls: ReadonlyMap<FunctionCall | FunctionBlockCall, UserCallInfo>;
  blockInputTypes: ReadonlyMap<Identifier, DataType>;
  blockCalls: ReadonlyMap<FunctionCall, number>;
  blockInOuts: ReadonlyMap<FunctionCall | FunctionBlockCall, UserCallInfo["inOuts"]>;
  result?: VariableSymbol;
}

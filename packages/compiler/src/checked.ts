import type {
  DataType,
  FunctionBlockType,
  ScalarValue,
  StandardFunction,
} from "@benchtop-plc/core";
import type { Expression, FunctionCall, Identifier, Program } from "./ast.js";

export interface Symbol {
  /** Index in declaration order, shared by all resolved references. */
  id: number;
  name: Identifier;
  type: DataType | FunctionBlockType;
  initialValue: ScalarValue | null;
}

export interface ExpressionInfo {
  dataType: DataType;
  /** Present only for literal/operator constant expressions, including FALSE and zero. */
  constant?: ScalarValue;
}

export interface ResolvedReference {
  variable: number;
  port?: "input" | "output";
  member?: number;
}

/** Semantic side tables use AST object identity; they are compiler-local, not wire IR. */
export interface CheckedProgram {
  ast: Program;
  symbols: readonly Symbol[];
  expressions: ReadonlyMap<Expression, ExpressionInfo>;
  references: ReadonlyMap<Identifier, ResolvedReference>;
  functions: ReadonlyMap<FunctionCall, StandardFunction>;
}

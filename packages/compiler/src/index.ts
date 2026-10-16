export * from "./ast.js";
export { lex } from "./lexer.js";
export type { LexResult, Token, TokenKind } from "./lexer.js";
export { parse } from "./parser.js";
export type { ParseResult } from "./parser.js";

export const packageName = "@benchtop-plc/compiler";

export { check } from "./checker.js";
export type { CheckResult } from "./checker.js";
export type {
  CheckedProgram,
  ExpressionInfo,
  ResolvedReference,
  VariableSymbol,
} from "./checked.js";

export * from "./ast.js";
export { isElementaryTypeName, isKeyword, lex } from "./lexer.js";
export type { LexResult, Token, TokenKind } from "./lexer.js";
export { parse, parsePou, parseDataType } from "./parser.js";
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

export { compile, compileProject } from "./compile.js";
export type { CompileDiagnostic, CompileResult } from "./compile.js";
export { lower } from "./lower.js";

export { resolveDataTypes } from "./data-types.js";

export { parseConfiguration } from "./configuration.js";
export type { Configuration, ImplicitConfiguration } from "./configuration.js";

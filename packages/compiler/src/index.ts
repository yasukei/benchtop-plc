export * from "./ast.js";
export { lex } from "./lexer.js";
export type { LexResult, Token, TokenKind } from "./lexer.js";
export { parse } from "./parser.js";
export type { ParseResult } from "./parser.js";

export const packageName = "@benchtop-plc/compiler";

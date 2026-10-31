import { coerceValue } from "@benchtop-plc/core";
import type { ScalarValue } from "@benchtop-plc/core";
import type { ExpressionInfo } from "./checked.js";
import type { Declaration } from "./ast.js";
export { unaryValue as unaryConstant, binaryValue as binaryConstant } from "@benchtop-plc/core";

/** Preserve invalid source qualifiers in the AST without losing parameter symbols. */
export function isConstantDeclaration(declaration: Declaration): boolean {
  return !!declaration.constant && (!declaration.section || declaration.section === "VAR_EXTERNAL");
}

/** Typed constant operations use exactly the same result coercion as execution. */
export function withConstant(info: ExpressionInfo, value: ScalarValue): ExpressionInfo {
  return { ...info, constant: coerceValue(info.dataType, value) };
}

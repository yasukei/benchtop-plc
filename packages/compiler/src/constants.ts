import { coerceValue } from "@benchtop-plc/core";
import type { ScalarValue } from "@benchtop-plc/core";
import type { ExpressionInfo } from "./checked.js";
export { unaryValue as unaryConstant, binaryValue as binaryConstant } from "@benchtop-plc/core";

/** Typed constant operations use exactly the same result coercion as execution. */
export function withConstant(info: ExpressionInfo, value: ScalarValue): ExpressionInfo {
  return { ...info, constant: coerceValue(info.dataType, value) };
}

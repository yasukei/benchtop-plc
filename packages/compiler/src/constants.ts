import { coerceValue } from "@benchtop-plc/core";
import type { BinaryOperator, ScalarValue, UnaryOperator } from "@benchtop-plc/core";
import type { ExpressionInfo } from "./checked.js";

export function unaryConstant(operator: UnaryOperator, value: ScalarValue): ScalarValue {
  switch (operator) {
    case "+":
      return Number(value);
    case "-":
      return -Number(value);
    case "NOT":
      return typeof value === "boolean" ? !value : ~value;
  }
}

export function binaryConstant(
  operator: BinaryOperator,
  left: ScalarValue,
  right: ScalarValue,
): ScalarValue {
  const a = Number(left),
    b = Number(right);
  switch (operator) {
    case "+":
      return a + b;
    case "-":
      return a - b;
    case "*":
      return a * b;
    case "/":
      return a / b;
    case "MOD":
      return b === 0 ? 0 : a % b;
    case "AND":
      return typeof left === "boolean" && typeof right === "boolean"
        ? left && Boolean(right)
        : a & b;
    case "OR":
      return typeof left === "boolean" && typeof right === "boolean"
        ? left || Boolean(right)
        : a | b;
    case "XOR":
      return typeof left === "boolean" && typeof right === "boolean" ? left !== right : a ^ b;
    case "=":
      return a === b;
    case "<>":
      return a !== b;
    case "<":
      return a < b;
    case ">":
      return a > b;
    case "<=":
      return a <= b;
    case ">=":
      return a >= b;
  }
}

/** Typed constant operations use exactly the same result coercion as execution. */
export function withConstant(info: ExpressionInfo, value: ScalarValue): ExpressionInfo {
  return { ...info, constant: coerceValue(info.dataType, value) };
}

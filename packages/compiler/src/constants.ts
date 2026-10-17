import { coerceValue } from "@benchtop-plc/core";
import type { BinaryOperator, DataType, ScalarValue, UnaryOperator } from "@benchtop-plc/core";
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
      return typeof left === "boolean" ? left && Boolean(right) : a & b;
    case "OR":
      return typeof left === "boolean" ? left || Boolean(right) : a | b;
    case "XOR":
      return typeof left === "boolean" ? left !== right : a ^ b;
    case "=":
      return left === right;
    case "<>":
      return left !== right;
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

/** Coerce operators to their result type; literals/signs can retain binary64 precision. */
export function withConstant(
  info: ExpressionInfo,
  value: ScalarValue,
  representation: DataType = info.dataType,
): ExpressionInfo {
  return { ...info, constant: coerceValue(representation, value) };
}

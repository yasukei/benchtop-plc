import type { BinaryOperator, UnaryOperator } from "./ir.js";
import type { ScalarValue } from "./values.js";

export function unaryValue(operator: UnaryOperator, value: ScalarValue): ScalarValue {
  if (typeof value === "string" || typeof value === "bigint") {
    const n = BigInt(value);
    return operator === "+" ? n : operator === "-" ? -n : ~n;
  }
  return operator === "+"
    ? Number(value)
    : operator === "-"
      ? -Number(value)
      : typeof value === "boolean"
        ? !value
        : ~value;
}
export function binaryValue(
  operator: BinaryOperator,
  left: ScalarValue,
  right: ScalarValue,
): ScalarValue {
  const long =
    typeof left === "string" ||
    typeof right === "string" ||
    typeof left === "bigint" ||
    typeof right === "bigint";
  if (long) {
    const a = BigInt(left),
      b = BigInt(right);
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
        return b === 0n ? 0n : a % b;
      case "AND":
        return a & b;
      case "OR":
        return a | b;
      case "XOR":
        return a ^ b;
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
      return typeof left === "boolean" && typeof right === "boolean" ? left && right : a & b;
    case "OR":
      return typeof left === "boolean" && typeof right === "boolean" ? left || right : a | b;
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

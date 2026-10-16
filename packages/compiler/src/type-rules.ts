import type { BinaryOperator, DataType, NumericType, UnaryOperator } from "@benchtop-plc/core";

export const integerTypes = ["INT", "UINT", "DINT"] as const;
export const numericTypes = ["INT", "UINT", "DINT", "REAL", "LREAL"] as const;
export const scalarTypes = ["BOOL", ...numericTypes, "TIME"] as const;
export const isInteger = (type: DataType): boolean => integerTypes.some((item) => item === type);
export const isNumeric = (type: DataType): boolean => numericTypes.some((item) => item === type);
export const isReal = (type: DataType): boolean => type === "REAL" || type === "LREAL";

export function assignable(to: DataType, from: DataType): boolean {
  return to === from || (isInteger(to) && isInteger(from)) || (isReal(to) && isNumeric(from));
}

/** Milestone arithmetic promotion deliberately produces REAL even for LREAL operands. */
export function promote(left: DataType, right: DataType): NumericType {
  return isReal(left) || isReal(right)
    ? "REAL"
    : left === "DINT" || right === "DINT"
      ? "DINT"
      : "INT";
}

export function unaryType(operator: UnaryOperator, operand: DataType): DataType | null {
  if (operator === "NOT") return operand === "BOOL" || isInteger(operand) ? operand : null;
  return isNumeric(operand) || operand === "TIME" ? operand : null;
}

export function binaryType(
  operator: BinaryOperator,
  left: DataType,
  right: DataType,
): DataType | null {
  const numeric = isNumeric(left) && isNumeric(right);
  const integers = isInteger(left) && isInteger(right);
  const times = left === "TIME" && right === "TIME";
  switch (operator) {
    case "+":
    case "-":
      return numeric ? promote(left, right) : times ? "TIME" : null;
    case "*":
    case "/":
      return numeric ? promote(left, right) : left === "TIME" && isNumeric(right) ? "TIME" : null;
    case "MOD":
      return integers ? promote(left, right) : null;
    case "AND":
    case "OR":
    case "XOR":
      return integers ? promote(left, right) : left === "BOOL" && right === "BOOL" ? "BOOL" : null;
    case "=":
    case "<>":
      return numeric || times || (left === "BOOL" && right === "BOOL") ? "BOOL" : null;
    case "<":
    case ">":
    case "<=":
    case ">=":
      return numeric || times ? "BOOL" : null;
  }
}

import type { BinaryOperator, DataType, UnaryOperator } from "@benchtop-plc/core";

export const integerTypes = ["INT", "UINT", "DINT"] as const;
export const numericTypes = ["INT", "UINT", "DINT", "REAL", "LREAL"] as const;
export const scalarTypes = ["BOOL", ...numericTypes, "TIME"] as const;
export const isInteger = (type: DataType): boolean => integerTypes.some((item) => item === type);
export const isNumeric = (type: DataType): boolean => numericTypes.some((item) => item === type);
export const isReal = (type: DataType): boolean => type === "REAL" || type === "LREAL";

const widening: Record<DataType, readonly DataType[]> = {
  BOOL: [],
  TIME: [],
  INT: ["DINT", "REAL", "LREAL"],
  UINT: ["DINT", "REAL", "LREAL"],
  DINT: ["LREAL"],
  REAL: ["LREAL"],
  LREAL: [],
};
export function assignable(to: DataType, from: DataType): boolean {
  return to === from || widening[from].includes(to);
}

/** ADR 0013: choose a least candidate from the entire set, then try integers only. */
export function commonType(types: readonly DataType[]): DataType | null {
  if (!types.length) return null;
  const candidates = scalarTypes.filter((to) => types.every((from) => assignable(to, from)));
  const least = (items: readonly DataType[]) =>
    items.find((from) => items.every((to) => assignable(to, from))) ?? null;
  return least(candidates) ?? (types.every(isInteger) ? least(candidates.filter(isInteger)) : null);
}

export function unaryType(operator: UnaryOperator, operand: DataType): DataType | null {
  if (operator === "NOT") return operand === "BOOL" || isInteger(operand) ? operand : null;
  if (operator === "-" && operand === "UINT") return null;
  return isNumeric(operand) || operand === "TIME" ? operand : null;
}

export function binaryType(
  operator: BinaryOperator,
  left: DataType,
  right: DataType,
): DataType | null {
  const common = commonType([left, right]);
  const numeric = isNumeric(left) && isNumeric(right);
  const integers = isInteger(left) && isInteger(right);
  const times = left === "TIME" && right === "TIME";
  switch (operator) {
    case "+":
    case "-":
      return numeric ? common : times ? "TIME" : null;
    case "*":
    case "/":
      return numeric ? common : left === "TIME" && isNumeric(right) ? "TIME" : null;
    case "MOD":
      return integers ? common : null;
    case "AND":
    case "OR":
    case "XOR":
      return integers ? common : left === "BOOL" && right === "BOOL" ? "BOOL" : null;
    case "=":
    case "<>":
    case "<":
    case ">":
    case "<=":
    case ">=":
      return common ? "BOOL" : null;
  }
}

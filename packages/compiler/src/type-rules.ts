import type { BinaryOperator, DataType, UnaryOperator } from "@benchtop-plc/core";

export { integerTypes } from "@benchtop-plc/core";
import { integerTypes, isIntegerType, isBitType } from "@benchtop-plc/core";
export const numericTypes = [...integerTypes, "REAL", "LREAL"] as const;
export const scalarTypes = ["BOOL", "BYTE", "WORD", "DWORD", ...numericTypes, "TIME"] as const;
export const isInteger = isIntegerType;
export const isNumeric = (type: DataType): boolean => numericTypes.some((item) => item === type);
export const isReal = (type: DataType): boolean => type === "REAL" || type === "LREAL";

// Select against the entire ADR 0012 type set before checking implementation support.
// Otherwise DINT + UDINT would silently fall back from LINT to LREAL.
type PlannedType =
  | DataType
  | "LINT"
  | "ULINT"
  | "LWORD"
  | "LTIME"
  | "DATE"
  | "LDATE"
  | "TOD"
  | "LTOD"
  | "DT"
  | "LDT";
const widening: Record<PlannedType, readonly PlannedType[]> = {
  SINT: ["INT", "REAL"],
  INT: ["DINT", "REAL"],
  DINT: ["LINT", "LREAL"],
  LINT: [],
  USINT: ["UINT", "INT", "REAL"],
  UINT: ["UDINT", "DINT", "REAL"],
  UDINT: ["ULINT", "LINT", "LREAL"],
  ULINT: [],
  REAL: ["LREAL"],
  LREAL: [],
  BOOL: ["BYTE"],
  BYTE: ["WORD"],
  WORD: ["DWORD"],
  DWORD: ["LWORD"],
  LWORD: [],
  TIME: ["LTIME"],
  LTIME: [],
  DATE: ["LDATE"],
  LDATE: [],
  TOD: ["LTOD"],
  LTOD: [],
  DT: ["LDT"],
  LDT: [],
};
function widens(to: PlannedType, from: PlannedType): boolean {
  return to === from || widening[from].some((next) => widens(to, next));
}
export function assignable(to: DataType, from: DataType): boolean {
  return widens(to, from);
}

/** ADR 0013: choose a least candidate from the entire set, then try integers only. */
export function commonType(types: readonly DataType[]): DataType | null {
  if (!types.length) return null;
  const candidates = (Object.keys(widening) as PlannedType[]).filter((to) =>
    types.every((from) => widens(to, from)),
  );
  const least = (items: readonly PlannedType[]) =>
    items.find((from) => items.every((to) => widens(to, from))) ?? null;
  const result =
    least(candidates) ??
    (types.every(isInteger)
      ? least(candidates.filter((type) => isInteger(type) || type === "LINT" || type === "ULINT"))
      : null);
  return scalarTypes.find((type) => type === result) ?? null;
}

export function unaryType(operator: UnaryOperator, operand: DataType): DataType | null {
  if (operator === "NOT") return isBitType(operand) ? operand : null;
  if (operator === "-" && ["USINT", "UINT", "UDINT"].includes(operand)) return null;
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
      return isBitType(left) && isBitType(right) ? common : null;
    case "=":
    case "<>":
    case "<":
    case ">":
    case "<=":
    case ">=":
      return common ? "BOOL" : null;
  }
}

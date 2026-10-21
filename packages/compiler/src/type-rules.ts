import type { BinaryOperator, DataType, UnaryOperator } from "@benchtop-plc/core";

export { integerTypes } from "@benchtop-plc/core";
import {
  calendarTypes,
  isCalendarType,
  integerTypes,
  isIntegerType,
  isBitType,
} from "@benchtop-plc/core";
export const numericTypes = [...integerTypes, "REAL", "LREAL"] as const;
export const scalarTypes = [
  "BOOL",
  "BYTE",
  "WORD",
  "DWORD",
  "LWORD",
  ...numericTypes,
  "TIME",
  "LTIME",
  ...calendarTypes,
] as const;
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
    (types.every(isInteger) ? least(candidates.filter((type) => isInteger(type))) : null);
  return scalarTypes.find((type) => type === result) ?? null;
}

export function unaryType(operator: UnaryOperator, operand: DataType): DataType | null {
  if (operator === "NOT") return isBitType(operand) ? operand : null;
  if (operator === "-" && ["USINT", "UINT", "UDINT", "ULINT"].includes(operand)) return null;
  return isNumeric(operand) || operand === "TIME" || operand === "LTIME" ? operand : null;
}

export function binaryType(
  operator: BinaryOperator,
  left: DataType,
  right: DataType,
): DataType | null {
  if ((operator === "+" || operator === "-") && isCalendarType(left)) {
    if (operator === "-" && isCalendarType(right)) {
      const common = commonType([left, right]);
      return common ? (common.startsWith("L") ? "LTIME" : "TIME") : null;
    }
    if (
      (left === "TOD" || left === "DT" || left === "LTOD" || left === "LDT") &&
      (right === "TIME" || right === "LTIME")
    )
      return left.startsWith("L") || right === "LTIME"
        ? (`L${left.replace(/^L/, "")}` as DataType)
        : left;
    return null;
  }
  const common = commonType([left, right]);
  const numeric = isNumeric(left) && isNumeric(right);
  const integers = isInteger(left) && isInteger(right);
  const duration = (type: DataType) => type === "TIME" || type === "LTIME";
  const times = duration(left) && duration(right);
  switch (operator) {
    case "+":
    case "-":
      return numeric ? common : times ? common : null;
    case "*":
    case "/":
      return numeric ? common : duration(left) && isNumeric(right) ? left : null;
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

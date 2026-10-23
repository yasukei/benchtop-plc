import { isCalendarType, isCharacterType } from "@benchtop-plc/core";
import { integerRanges, isLongType, roundRational } from "@benchtop-plc/core";
import type { DataType, ScalarValue } from "@benchtop-plc/core";
import type { Expression } from "./ast.js";

export interface Exact {
  n: bigint;
  d: bigint;
  real: boolean;
}
function fraction(n: bigint, d = 1n, real = false): Exact {
  if (d === 0n) throw new RangeError("Division by zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let a = n < 0n ? -n : n,
    b = d;
  while (b) [a, b] = [b, a % b];
  return { n: n / a, d: d / a, real };
}
// Bound decimal power construction so editing or restoring source cannot allocate
// enormous BigInts on the browser main thread. Arithmetic within the budget is exact.
export const MAX_DECIMAL_SCALE = 10000;
export function exactNumber(text: string): Exact {
  const clean = text.replaceAll("_", "");
  const based = /^([+-]?)(2|16)#(.+)$/i.exec(clean);
  if (based)
    return fraction(
      BigInt(`${based[2] === "2" ? "0b" : "0x"}${based[3]}`) * (based[1] === "-" ? -1n : 1n),
    );
  const [mantissa = "0", exponent = "0"] = clean.toLowerCase().split("e");
  const scale = Number(exponent) - (mantissa.split(".")[1]?.length ?? 0);
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > MAX_DECIMAL_SCALE)
    throw new RangeError("Constant decimal scale exceeds evaluation budget");
  const n = BigInt(mantissa.replace(".", "").replace(/^\+/, ""));
  return fraction(
    scale >= 0 ? n * 10n ** BigInt(scale) : n,
    scale >= 0 ? 1n : 10n ** BigInt(-scale),
    /[.eE]/.test(clean),
  );
}

/** This syntactic class alone defers typing; typed literals and calls end it. */
export function isUntyped(node: Expression): boolean {
  switch (node.kind) {
    case "literal":
      return !node.dataType && (node.literalKind === "integer" || node.literalKind === "real");
    case "group":
      return isUntyped(node.expression);
    case "unary":
      return node.operator !== "NOT" && isUntyped(node.operand);
    case "binary":
      return (
        ["+", "-", "*", "/", "MOD"].includes(node.operator) &&
        (node.operator !== "MOD" || !hasReal(node)) &&
        isUntyped(node.left) &&
        isUntyped(node.right)
      );
    default:
      return false;
  }
}
function hasReal(node: Expression): boolean {
  switch (node.kind) {
    case "literal":
      return node.literalKind === "real";
    case "group":
      return hasReal(node.expression);
    case "unary":
      return hasReal(node.operand);
    case "binary":
      return hasReal(node.left) || hasReal(node.right);
    default:
      return false;
  }
}
export function exactConstant(node: Expression, real = hasReal(node)): Exact {
  switch (node.kind) {
    case "literal":
      return { ...exactNumber(node.text), real };
    case "group":
      return exactConstant(node.expression, real);
    case "unary": {
      const a = exactConstant(node.operand, real);
      return { ...a, n: node.operator === "-" ? -a.n : a.n };
    }
    case "binary": {
      // MOD accepts integer operands; division below it must truncate even when
      // a real literal elsewhere makes the enclosing arithmetic fractional.
      const operandReal = node.operator === "MOD" ? false : real;
      const a = exactConstant(node.left, operandReal),
        b = exactConstant(node.right, operandReal);
      switch (node.operator) {
        case "+":
          return fraction(a.n * b.d + b.n * a.d, a.d * b.d, real);
        case "-":
          return fraction(a.n * b.d - b.n * a.d, a.d * b.d, real);
        case "*":
          return fraction(a.n * b.n, a.d * b.d, real);
        case "/": {
          const result = fraction(a.n * b.d, a.d * b.n, real);
          return real ? result : fraction(result.n / result.d);
        }
        case "MOD":
          if (hasReal(node)) throw new RangeError("MOD needs integers");
          return fraction(b.n === 0n ? 0n : a.n % b.n);
      }
    }
  }
  throw new Error("Not an untyped constant");
}

/** Materialize exact constants through the shared single-rounding helper. */
export function roundReal(value: Exact, type: "REAL" | "LREAL"): number {
  return roundRational(value, type);
}
export function acceptsKind(type: DataType, value: Exact): boolean {
  return value.real
    ? type === "REAL" || type === "LREAL"
    : !isCharacterType(type) && type !== "TIME" && type !== "LTIME" && !isCalendarType(type);
}
export function materialize(value: Exact, type: DataType): ScalarValue {
  if (!acceptsKind(type, value)) throw new RangeError("Constant kind mismatch");
  if (type === "REAL" || type === "LREAL") return roundReal(value, type);
  if (type === "BOOL") {
    if (value.n !== 0n && value.n !== value.d) throw new RangeError("BOOL constant out of range");
    return value.n !== 0n;
  }
  if (isCharacterType(type) || type === "TIME" || type === "LTIME" || isCalendarType(type))
    throw new RangeError("Numeric constant is not TIME");
  const [min, max] = integerRanges[type].map(BigInt) as [bigint, bigint];
  if (value.d !== 1n || value.n < min || value.n > max)
    throw new RangeError("Integer constant out of range");
  return isLongType(type) ? value.n.toString() : Number(value.n);
}
export function defaultType(value: Exact): DataType {
  if (value.real) return "LREAL";
  if (value.n >= -2147483648n && value.n <= 2147483647n) return "DINT";
  if (value.n >= -(1n << 63n) && value.n < 1n << 63n) return "LINT";
  // LREAL is the remaining fallback only when it holds the integer exactly.
  const result = roundReal(value, "LREAL");
  if (BigInt(result) !== value.n) throw new RangeError("No exact default type");
  return "LREAL";
}

/** Lexer-validated durations are evaluated exactly before materializing ms or ns. */
export function timeLiteral(text: string): number | string {
  const long = /^(LT|LTIME)#/i.test(text);
  const duration = text.slice(text.indexOf("#") + 1);
  const units: Record<string, bigint> = {
    d: 86400000000000n,
    h: 3600000000000n,
    m: 60000000000n,
    s: 1000000000n,
    ms: 1000000n,
    us: 1000n,
    ns: 1n,
  };
  let value = fraction(0n);
  for (const part of duration.matchAll(/([\d_]+(?:\.[\d_]+)?)(ms|us|ns|d|h|m|s)/gi)) {
    const amount = exactNumber(part[1]!);
    value = fraction(
      value.n * amount.d + amount.n * units[part[2]!.toLowerCase()]! * value.d,
      value.d * amount.d,
    );
  }
  if (duration.startsWith("-")) value.n = -value.n;
  if (!long) value.d *= 1000000n;
  const [min, max] = integerRanges[long ? "LTIME" : "TIME"].map(BigInt) as [bigint, bigint];
  if ((long && value.n % value.d !== 0n) || value.n < min * value.d || value.n > max * value.d)
    throw new RangeError("TIME literal out of range");
  return long ? (value.n / value.d).toString() : Number(value.n / value.d);
}

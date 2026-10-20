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

/** Round a rational directly to IEEE binary32/64, including subnormals and ties. */
export function roundReal(value: Exact, type: "REAL" | "LREAL"): number {
  const negative = value.n < 0n;
  const n = negative ? -value.n : value.n,
    d = value.d;
  if (!n) return 0;
  let exponent = n.toString(2).length - d.toString(2).length;
  if (exponent >= 0 ? n < d << BigInt(exponent) : n << BigInt(-exponent) < d) exponent--;
  const precision = type === "REAL" ? 24 : 53;
  const unit = Math.max(exponent - precision + 1, type === "REAL" ? -149 : -1074);
  const numerator = unit < 0 ? n << BigInt(-unit) : n;
  const denominator = unit > 0 ? d << BigInt(unit) : d;
  let q = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n > denominator || (remainder * 2n === denominator && q % 2n !== 0n)) q++;
  const result = Number(q) * 2 ** unit * (negative ? -1 : 1);
  if (!Number.isFinite(result) || (type === "REAL" && !Number.isFinite(Math.fround(result))))
    throw new RangeError("Real overflow");
  return result || 0;
}
export function acceptsKind(type: DataType, value: Exact): boolean {
  return value.real ? type === "REAL" || type === "LREAL" : type !== "TIME";
}
export function materialize(value: Exact, type: DataType): ScalarValue {
  if (!acceptsKind(type, value)) throw new RangeError("Constant kind mismatch");
  if (type === "REAL" || type === "LREAL") return roundReal(value, type);
  if (type === "BOOL") {
    if (value.n !== 0n && value.n !== value.d) throw new RangeError("BOOL constant out of range");
    return value.n !== 0n;
  }
  const ranges = {
    INT: [-32768n, 32767n],
    UINT: [0n, 65535n],
    DINT: [-2147483648n, 2147483647n],
  } as const;
  if (type === "TIME") throw new RangeError("Numeric constant is not TIME");
  const [min, max] = ranges[type];
  if (value.d !== 1n || value.n < min || value.n > max)
    throw new RangeError("Integer constant out of range");
  return Number(value.n);
}
export function defaultType(value: Exact): DataType {
  if (value.real) return "LREAL";
  if (value.n >= -2147483648n && value.n <= 2147483647n) return "DINT";
  // LINT is not implemented yet. LREAL is the remaining ADR 0013 fallback only
  // when it holds the integer exactly; never lose integer digits silently.
  const result = roundReal(value, "LREAL");
  if (BigInt(result) !== value.n) throw new RangeError("No exact default type");
  return "LREAL";
}

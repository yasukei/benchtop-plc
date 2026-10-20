import type { DataType } from "./values.js";
import { coerceTime } from "./values.js";

/** External TIME values are checked before coercion, so they cannot silently wrap. */
export function validateTime(value: number): void {
  if (!Number.isInteger(value) || Object.is(value, -0) || value < -2147483648 || value > 2147483647)
    throw new RangeError("Invalid TIME value");
}

/** The exact rational represented by a finite IEEE binary64 operand. */
function realFraction(value: number): [bigint, bigint] {
  if (!Number.isFinite(value)) throw new RangeError("Non-finite TIME operand");
  const bytes = new DataView(new ArrayBuffer(8));
  bytes.setFloat64(0, value);
  const bits = bytes.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const mantissa = (bits & ((1n << 52n) - 1n)) | (exponent ? 1n << 52n : 0n);
  const n = bits >> 63n ? -mantissa : mantissa;
  const shift = (exponent || 1) - 1023 - 52;
  return shift >= 0 ? [n << BigInt(shift), 1n] : [n, 1n << BigInt(-shift)];
}

/** Shared TIME arithmetic for typed constants and execution (ADR 0012/0013). */
export function timeBinary(
  operator: "+" | "-" | "*" | "/",
  left: number,
  right: number,
  rightType: DataType,
): number {
  if (operator === "+") return coerceTime(left + right);
  if (operator === "-") return coerceTime(left - right);
  const real = rightType === "REAL" || rightType === "LREAL";
  const [factor, divisor] = real ? realFraction(right) : [BigInt(right), 1n];
  let n = BigInt(left) * (operator === "*" ? factor : divisor);
  let d = operator === "*" ? divisor : factor;
  if (!d) throw new RangeError("Division by zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  let result = n / d;
  const remainder = n < 0n ? -(n % d) : n % d;
  if (real && (remainder * 2n > d || (remainder * 2n === d && result % 2n !== 0n)))
    result += n < 0n ? -1n : 1n;
  return Number(BigInt.asIntN(32, result));
}

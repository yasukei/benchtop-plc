/** Round a rational directly to IEEE binary32/64, including subnormals and ties. */
export function roundRational(value: { n: bigint; d: bigint }, type: "REAL" | "LREAL"): number {
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

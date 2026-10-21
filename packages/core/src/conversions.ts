import type { ConversionFunction } from "./ir.js";
import type { DataType, ScalarValue } from "./values.js";
import { coerceValue, isBitType, isIntegerType, integerWidths } from "./values.js";
import { conversionFunctions } from "./standard-library.js";
import { roundRational } from "./rounding.js";
import { realFraction } from "./time.js";

/** Shared by constant evaluation and execution, so typed constants have runtime semantics. */
export function convertValue(name: ConversionFunction, value: ScalarValue): ScalarValue {
  const source = name.startsWith("TO_") ? null : (name.split("_TO_")[0] as DataType);
  const input = source ? coerceValue(source, value) : value;
  const to = conversionFunctions[name].result!;
  if ((source === "LREAL" && to === "LWORD") || (source === "LWORD" && to === "LREAL")) {
    const buffer = new DataView(new ArrayBuffer(8));
    if (source === "LREAL") {
      buffer.setFloat64(0, Number(input));
      return buffer.getBigUint64(0).toString();
    }
    buffer.setBigUint64(0, BigInt(input));
    return coerceValue("LREAL", buffer.getFloat64(0));
  }
  if ((source === "REAL" && to === "DWORD") || (source === "DWORD" && to === "REAL")) {
    const buffer = new DataView(new ArrayBuffer(4));
    if (source === "REAL") {
      buffer.setFloat32(0, Number(input));
      return buffer.getUint32(0);
    }
    buffer.setUint32(0, Number(input));
    return coerceValue("REAL", buffer.getFloat32(0));
  }
  if (source && isBitType(to) && isIntegerType(source)) {
    // Transfer the source-width pattern, with zero fill rather than sign extension.
    return coerceValue(to, BigInt.asUintN(integerWidths[source], BigInt(input)));
  }
  if ((to === "REAL" || to === "LREAL") && source && isIntegerType(source))
    return roundRational({ n: BigInt(input), d: 1n }, to);
  if (to === "BOOL") return (BigInt(input) & 1n) !== 0n;
  if (source === "TIME" && to === "LTIME") return coerceValue(to, BigInt(input) * 1000000n);
  if (source === "LTIME" && to === "TIME") return coerceValue(to, BigInt(input) / 1000000n);
  if (isIntegerType(to)) {
    if (source === "REAL" || source === "LREAL") {
      const [n, d] = realFraction(Number(input));
      let q = n / d;
      const remainder = n < 0n ? -(n % d) : n % d;
      if (remainder * 2n > d || (remainder * 2n === d && q % 2n !== 0n)) q += n < 0n ? -1n : 1n;
      // Reduce before converting to number, including very large finite reals.
      return coerceValue(
        to,
        to === "LINT" || to === "ULINT" ? q : Number(BigInt.asUintN(integerWidths[to], q)),
      );
    }
    return coerceValue(to, input);
  }
  return coerceValue(to, input);
}

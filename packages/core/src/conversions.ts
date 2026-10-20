import type { ConversionFunction } from "./ir.js";
import type { DataType, ScalarValue } from "./values.js";
import { coerceValue, isBitType, isIntegerType, integerWidths } from "./values.js";
import { conversionFunctions } from "./standard-library.js";

/** Shared by constant evaluation and execution, so typed constants have runtime semantics. */
export function convertValue(name: ConversionFunction, value: ScalarValue): ScalarValue {
  const source = name.startsWith("TO_") ? null : (name.split("_TO_")[0] as DataType);
  const input = source ? Number(coerceValue(source, value)) : Number(value);
  const to = conversionFunctions[name].result!;
  if ((source === "REAL" && to === "DWORD") || (source === "DWORD" && to === "REAL")) {
    const buffer = new DataView(new ArrayBuffer(4));
    if (source === "REAL") {
      buffer.setFloat32(0, input);
      return buffer.getUint32(0);
    }
    buffer.setUint32(0, input);
    return coerceValue("REAL", buffer.getFloat32(0));
  }
  if (source && isBitType(to) && isIntegerType(source)) {
    // Transfer the source-width pattern, with zero fill rather than sign extension.
    const pattern = input >>> 0;
    const width = integerWidths[source];
    return coerceValue(to, width === 32 ? pattern : pattern & (2 ** width - 1));
  }
  if (to === "BOOL") return (input & 1) !== 0;
  if (isIntegerType(to)) {
    const lower = Math.floor(input);
    const fraction = input - lower;
    const rounded =
      fraction < 0.5 ? lower : fraction > 0.5 ? lower + 1 : lower % 2 === 0 ? lower : lower + 1;
    return coerceValue(to, rounded);
  }
  return coerceValue(to, input);
}

import type { ConversionFunction } from "./ir.js";
import type { ScalarValue } from "./values.js";
import { coerceValue } from "./values.js";
import { conversionFunctions } from "./standard-library.js";

/** Shared by constant evaluation and execution, so typed constants have runtime semantics. */
export function convertValue(name: ConversionFunction, value: ScalarValue): ScalarValue {
  const source = name.startsWith("TO_") ? null : name.split("_TO_")[0];
  const input = source === "REAL" ? coerceValue("REAL", value) : Number(value);
  const to = conversionFunctions[name].result!;
  if (to === "INT" || to === "DINT" || to === "UINT") {
    const lower = Math.floor(input);
    const fraction = input - lower;
    const rounded =
      fraction < 0.5 ? lower : fraction > 0.5 ? lower + 1 : lower % 2 === 0 ? lower : lower + 1;
    return coerceValue(to, rounded);
  }
  return coerceValue(to, input);
}

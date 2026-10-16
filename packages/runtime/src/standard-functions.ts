import { coerceValue, getStandardFunctionSignature } from "@benchtop-plc/core";
import type { ScalarValue, StandardFunction } from "@benchtop-plc/core";

/** IEC conversion rounds halfway values to the nearest even integer, including negatives. */
function roundToEven(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  return fraction < 0.5 ? lower : fraction > 0.5 ? lower + 1 : lower % 2 === 0 ? lower : lower + 1;
}

/** Arguments are compiler-checked; the interpreter coerces polymorphic results to the IR type. */
export function callStandardFunction(
  name: StandardFunction,
  args: readonly ScalarValue[],
): ScalarValue {
  const signature = getStandardFunctionSignature(name);
  if (args.length < signature.min || (signature.max !== null && args.length > signature.max))
    throw new Error(`Invalid argument count for ${name}`);
  if (args.some((value) => !Number.isFinite(Number(value))))
    throw new RangeError("PLC values must be finite");
  const first = Number(args[0]);
  switch (name) {
    case "ABS":
      return Math.abs(first);
    case "MIN":
      return args.reduce<number>((value, arg) => Math.min(value, Number(arg)), first);
    case "MAX":
      return args.reduce<number>((value, arg) => Math.max(value, Number(arg)), first);
    case "LIMIT":
      return Math.min(Math.max(Number(args[1]), first), Number(args[2]));
    case "SEL":
      return args[args[0] ? 2 : 1]!;
    case "REAL_TO_INT":
      return coerceValue("INT", roundToEven(coerceValue("REAL", first)));
    case "INT_TO_REAL":
      return coerceValue("REAL", first);
    case "TIME_TO_INT":
      return coerceValue("INT", first);
    case "INT_TO_TIME":
      return coerceValue("TIME", first);
    case "BOOL_TO_INT":
      return args[0] ? 1 : 0;
  }
}

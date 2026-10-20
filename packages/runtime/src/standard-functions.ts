import { convertValue, getStandardFunctionSignature } from "@benchtop-plc/core";
import type { ScalarValue, StandardFunction } from "@benchtop-plc/core";

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
    default:
      return convertValue(name, args[0]!);
  }
}

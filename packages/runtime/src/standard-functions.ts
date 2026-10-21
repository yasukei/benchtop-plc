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
  const long = args.some((value) => typeof value === "string" || typeof value === "bigint");
  const compare = (a: ScalarValue, b: ScalarValue) =>
    long ? BigInt(a) < BigInt(b) : Number(a) < Number(b);
  switch (name) {
    case "ABS":
      return long
        ? BigInt(args[0]!) < 0n
          ? -BigInt(args[0]!)
          : BigInt(args[0]!)
        : Math.abs(first);
    case "MIN":
      return args.reduce((value, arg) => (compare(arg, value) ? arg : value));
    case "MAX":
      return args.reduce((value, arg) => (compare(value, arg) ? arg : value));
    case "LIMIT": {
      const lower = compare(args[1]!, args[0]!) ? args[0]! : args[1]!;
      return compare(args[2]!, lower) ? args[2]! : lower;
    }
    case "SEL":
      return args[args[0] ? 2 : 1]!;
    default:
      return convertValue(name, args[0]!);
  }
}

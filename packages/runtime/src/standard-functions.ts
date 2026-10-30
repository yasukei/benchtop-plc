import {
  timeArithmeticFunctions,
  stringFunctions,
  internalValue,
  calendarFunctions,
  binaryValue,
  bitWidths,
  coerceValue,
  convertValue,
  getStandardFunctionSignature,
  isBitType,
  isIntegerType,
  unaryValue,
} from "@benchtop-plc/core";
import type {
  BinaryOperator,
  ConversionFunction,
  DataType,
  ScalarValue,
  StandardFunction,
} from "@benchtop-plc/core";

import type { FunctionCallContext } from "./library.js";
import { callStringFunction } from "./string-functions.js";
import { callCalendarFunction, callTimeArithmetic } from "./time-date-functions.js";

/** Arguments are compiler-checked. Width-dependent operations require the IR result type. */
export function callStandardFunction(
  name: StandardFunction,
  values: readonly ScalarValue[],
  dataType?: DataType,
  context?: FunctionCallContext,
): ScalarValue {
  const signature = getStandardFunctionSignature(name);
  const args = values.map((value, index) => {
    const accepted = signature.arguments[Math.min(index, signature.arguments.length - 1)]!;
    const type =
      context?.argumentTypes?.[index] ??
      (accepted.length === 1
        ? accepted[0]
        : (signature.genericStart !== undefined &&
              index >= signature.genericStart &&
              index < (signature.genericEnd ?? values.length)) ||
            signature.resultArgument === index
          ? dataType
          : undefined);
    return type ? internalValue(type, value) : value;
  });
  if (args.length < signature.min || (signature.max !== null && args.length > signature.max))
    throw new Error(`Invalid argument count for ${name}`);
  if (args.some((value) => typeof value !== "string" && !Number.isFinite(Number(value))))
    throw new RangeError("PLC values must be finite");
  if (Object.hasOwn(stringFunctions, name))
    return callStringFunction(name as keyof typeof stringFunctions, args);
  if (Object.hasOwn(timeArithmeticFunctions, name))
    return callTimeArithmetic(
      name as keyof typeof timeArithmeticFunctions,
      args,
      context?.argumentTypes,
    );
  if (Object.hasOwn(calendarFunctions, name))
    return callCalendarFunction(name as keyof typeof calendarFunctions, args, context);
  const first = Number(args[0]);
  const long = args.some((value) => typeof value === "bigint");
  const compare = (a: ScalarValue, b: ScalarValue) =>
    typeof a === "string" && typeof b === "string"
      ? a < b
      : long
        ? BigInt(a) < BigInt(b)
        : Number(a) < Number(b);
  const quantize = (value: ScalarValue): ScalarValue =>
    dataType ? coerceValue(dataType, value) : value;
  const numeric = (operation: (value: number) => number): ScalarValue => {
    const result = operation(first);
    if (!Number.isFinite(result)) throw new RangeError("Non-finite function result");
    return quantize(result);
  };
  const fold = (operator: BinaryOperator): ScalarValue =>
    args.reduce((left, right) => {
      // BigInt also protects 32-bit products from binary64 rounding before wrapping.
      const exact = long || (dataType !== undefined && isIntegerType(dataType));
      return quantize(
        binaryValue(operator, exact ? BigInt(left) : left, exact ? BigInt(right) : right),
      );
    });
  if (name.includes("TRUNC_")) {
    const source = name.startsWith("TRUNC_") ? null : (name.split("_TRUNC_")[0] as DataType);
    const value = source ? coerceValue(source, args[0]!) : args[0]!;
    return coerceValue(signature.result!, BigInt(Math.trunc(Number(value))));
  }
  if (name.includes("_BCD_TO_")) {
    const source = name.split("_BCD_TO_")[0] as DataType;
    let bits = BigInt(coerceValue(source, args[0]!)),
      result = 0n,
      place = 1n;
    while (bits) {
      const digit = bits & 15n;
      if (digit > 9n) throw new RangeError("Invalid BCD digit");
      result += digit * place;
      place *= 10n;
      bits >>= 4n;
    }
    return coerceValue(signature.result!, result);
  }
  if (name.includes("_TO_BCD_")) {
    const source = name.split("_TO_BCD_")[0] as DataType;
    let value = BigInt(coerceValue(source, args[0]!)),
      result = 0n,
      shift = 0n;
    if (value < 0n) throw new RangeError("BCD requires a nonnegative integer");
    while (value) {
      result |= (value % 10n) << shift;
      value /= 10n;
      shift += 4n;
    }
    return coerceValue(signature.result!, result);
  }
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check -- Strings and calendar functions return before this switch; the default treats remaining names as conversions.
  switch (name) {
    case "ABS":
      return quantize(
        long ? (BigInt(args[0]!) < 0n ? -BigInt(args[0]!) : BigInt(args[0]!)) : Math.abs(first),
      );
    case "SQRT":
      return numeric(Math.sqrt);
    case "LN":
      return numeric(Math.log);
    case "LOG":
      return numeric(Math.log10);
    case "EXP":
      return numeric(Math.exp);
    case "SIN":
      return numeric(Math.sin);
    case "COS":
      return numeric(Math.cos);
    case "TAN":
      return numeric(Math.tan);
    case "ASIN":
      return numeric(Math.asin);
    case "ACOS":
      return numeric(Math.acos);
    case "ATAN":
      return numeric(Math.atan);
    case "ATAN2":
      return numeric((value) => Math.atan2(value, Number(args[1])));
    case "EXPT":
      return numeric(() => Number(binaryValue("**", args[0]!, args[1]!)));
    case "ADD":
      return fold("+");
    case "MUL":
      return fold("*");
    case "SUB":
      return fold("-");
    case "DIV":
      if (Number(args[1]) === 0) throw new RangeError("Division by zero");
      return fold("/");
    case "MOD":
      return fold("MOD");
    case "AND":
      return fold("AND");
    case "OR":
      return fold("OR");
    case "XOR":
      return fold("XOR");
    case "NOT":
      return quantize(unaryValue("NOT", args[0]!));
    case "SHL":
    case "SHR":
    case "ROL":
    case "ROR": {
      if (!dataType || !isBitType(dataType)) throw new Error("Shift requires a bit result type");
      const width = BigInt(bitWidths[dataType]);
      let count = BigInt(args[1]!);
      if (count < 0n) throw new RangeError("Negative shift count");
      const value = BigInt(args[0]!);
      if (name === "SHL" || name === "SHR")
        return quantize(count >= width ? 0n : name === "SHL" ? value << count : value >> count);
      count %= width;
      return quantize(
        name === "ROL"
          ? (value << count) | (value >> (width - count))
          : (value >> count) | (value << (width - count)),
      );
    }
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
    case "MUX": {
      const selector = BigInt(args[0]!);
      if (selector < 0n || selector >= BigInt(args.length - 1))
        throw new RangeError("MUX selector out of range");
      return args[Number(selector) + 1]!;
    }
    case "MOVE":
      return args[0]!;
    case "GT":
    case "GE":
    case "EQ":
    case "LE":
    case "LT":
    case "NE":
      return args.slice(1).every((right, index) => {
        const left = args[index]!;
        switch (name) {
          case "GT":
            return compare(right, left);
          case "GE":
            return !compare(left, right);
          case "LT":
            return compare(left, right);
          case "LE":
            return !compare(right, left);
          case "EQ":
            return !compare(left, right) && !compare(right, left);
          case "NE":
            return compare(left, right) || compare(right, left);
        }
      });
    default:
      return convertValue(name as ConversionFunction, args[0]!, context?.argumentTypes?.[0]);
  }
}

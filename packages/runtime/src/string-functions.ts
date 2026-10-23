import { MAX_STRING_LENGTH, type ScalarValue, type StringFunction } from "@benchtop-plc/core";

/** Positions are checked as bigint before narrowing; lengths past the end are clamped. */
export function callStringFunction(
  name: StringFunction,
  args: readonly ScalarValue[],
): ScalarValue {
  const input = String(args[0]);
  const second = String(args[1]);
  const length = (index: number): number => {
    const value = BigInt(args[index]!);
    if (value < 0n) throw new RangeError("Negative string length");
    return Number(value > BigInt(input.length) ? BigInt(input.length) : value);
  };
  const position = (index: number, insert = false): number => {
    const value = BigInt(args[index]!);
    if (value < (insert ? 0n : 1n) || value > BigInt(input.length))
      throw new RangeError("String position out of range");
    return Number(value) - (insert ? 0 : 1);
  };
  let result: string;
  switch (name) {
    case "LEN":
      return input.length;
    case "FIND":
      return second === "" ? 0 : input.indexOf(second) + 1;
    case "LEFT":
      result = input.slice(0, length(1));
      break;
    case "RIGHT":
      result = input.slice(input.length - length(1));
      break;
    case "MID": {
      const start = position(2);
      result = input.slice(start, start + length(1));
      break;
    }
    case "CONCAT":
      result = args.join("");
      break;
    case "INSERT": {
      const start = position(2, true);
      result = input.slice(0, start) + second + input.slice(start);
      break;
    }
    case "DELETE": {
      const start = position(2);
      result = input.slice(0, start) + input.slice(start + length(1));
      break;
    }
    case "REPLACE": {
      const start = position(3);
      result = input.slice(0, start) + second + input.slice(start + length(2));
      break;
    }
  }
  return result.slice(0, MAX_STRING_LENGTH);
}

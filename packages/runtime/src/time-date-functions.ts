import {
  calendarBinary,
  calendarUnit,
  coerceCalendar,
  dayNs,
  floorDiv,
  isCalendarType,
  ltimeBinary,
  modulo,
  timeArithmeticFunctions,
  timeBinary,
} from "@benchtop-plc/core";
import type {
  CalendarFunction,
  CalendarType,
  DataType,
  ScalarValue,
  TimeArithmeticFunction,
} from "@benchtop-plc/core";
import type { FunctionCallContext } from "./library.js";

/** Named arithmetic deliberately uses the same primitives as the ST operators. */
export function callTimeArithmetic(
  name: TimeArithmeticFunction,
  args: readonly ScalarValue[],
  types?: readonly DataType[],
): ScalarValue {
  const signature = timeArithmeticFunctions[name];
  const leftType = signature.arguments[0]![0];
  const operator = signature.operator!;
  const rightType =
    types?.[1] ??
    (signature.arguments[1]!.length === 1
      ? signature.arguments[1]![0]
      : Number.isInteger(Number(args[1]))
        ? "DINT"
        : "LREAL");
  if (isCalendarType(leftType))
    return calendarBinary(operator, leftType, args[0]!, rightType, args[1]!);
  const right = rightType === "REAL" || rightType === "LREAL" ? Number(args[1]) : BigInt(args[1]!);
  return leftType === "LTIME"
    ? ltimeBinary(operator, BigInt(args[0]!), right, rightType!)
    : timeBinary(operator, Number(args[0]), right, rightType!);
}

function dateNs(parts: readonly bigint[]): bigint {
  const [year, month, day] = parts as readonly [bigint, bigint, bigint];
  if (year < 1n || year > 9999n || month < 1n || month > 12n || day < 1n || day > 31n)
    throw new RangeError("Invalid date components");
  const stamp = new Date(0);
  stamp.setUTCFullYear(Number(year), Number(month - 1n), Number(day));
  if (
    stamp.getUTCFullYear() !== Number(year) ||
    stamp.getUTCMonth() !== Number(month - 1n) ||
    stamp.getUTCDate() !== Number(day)
  )
    throw new RangeError("Invalid date components");
  return BigInt(stamp.getTime()) * 1000000n;
}
function timeNs(parts: readonly bigint[]): bigint {
  const [hour, minute, second, ms] = parts as readonly [bigint, bigint, bigint, bigint];
  if (
    hour < 0n ||
    hour > 23n ||
    minute < 0n ||
    minute > 59n ||
    second < 0n ||
    second > 59n ||
    ms < 0n ||
    ms > 999n
  )
    throw new RangeError("Invalid time components");
  return ((hour * 60n + minute) * 60n + second) * 1000000000n + ms * 1000000n;
}

export function callCalendarFunction(
  name: CalendarFunction,
  args: readonly ScalarValue[],
  context?: FunctionCallContext,
): ScalarValue {
  if (name === "CONCAT_DATE_TOD" || name === "CONCAT_DATE_LTOD") {
    const dateType = context?.argumentTypes[0] ?? "DATE";
    const type = name === "CONCAT_DATE_TOD" ? "DT" : "LDT";
    const ns =
      BigInt(args[0]!) * calendarUnit(dateType as CalendarType) +
      BigInt(args[1]!) * (type === "DT" ? 1000000n : 1n);
    return coerceCalendar(type, floorDiv(ns, calendarUnit(type)));
  }
  if (name.startsWith("CONCAT_")) {
    const type = name.slice(7) as CalendarType;
    const parts = args.map((value) => BigInt(value));
    const date = type === "DATE" || type === "DT" || type === "LDT";
    const time = type !== "DATE";
    const ns =
      (date ? dateNs(parts.slice(0, 3)) : 0n) + (time ? timeNs(parts.slice(date ? 3 : 0)) : 0n);
    return coerceCalendar(type, floorDiv(ns, calendarUnit(type)));
  }
  const type =
    context?.argumentTypes[0] ??
    ((name === "DAY_OF_WEEK" ? "DATE" : name.slice(6)) as CalendarType);
  const ns = BigInt(args[0]!) * calendarUnit(type as CalendarType);
  const stamp = new Date(Number(floorDiv(ns, dayNs) * 86400000n));
  if (name === "DAY_OF_WEEK") return stamp.getUTCDay();
  const tod = modulo(ns, dayNs);
  const seconds = tod / 1000000000n;
  const date = [stamp.getUTCFullYear(), stamp.getUTCMonth() + 1, stamp.getUTCDate()];
  const time = [
    Number(seconds / 3600n),
    Number((seconds / 60n) % 60n),
    Number(seconds % 60n),
    Number((tod % 1000000000n) / 1000000n),
  ];
  const fields =
    name === "SPLIT_DATE"
      ? date
      : name === "SPLIT_DT" || name === "SPLIT_LDT"
        ? [...date, ...time]
        : time;
  fields.forEach((value, index) => context?.output(index, value));
  return true;
}

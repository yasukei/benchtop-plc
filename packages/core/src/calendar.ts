import type { ScalarValue } from "./scalar.js";

export const calendarTypes = ["DATE", "TOD", "DT", "LDATE", "LTOD", "LDT"] as const;
export type CalendarType = (typeof calendarTypes)[number];
export const isCalendarType = (type: string): type is CalendarType =>
  calendarTypes.some((item) => item === type);
export const dayNs = 86400000000000n;
export const floorDiv = (n: bigint, d: bigint): bigint => n / d - (n % d < 0n ? 1n : 0n);
export const modulo = (n: bigint, d: bigint): bigint => ((n % d) + d) % d;
export const calendarUnit = (type: CalendarType): bigint =>
  type.startsWith("L") ? 1n : type === "TOD" ? 1000000n : 1000000000n;

/** Storage invariants, checked before accepting any externally supplied value. */
export function validateCalendar(type: CalendarType, value: bigint): void {
  const long = type.startsWith("L");
  if (value < (long ? -(1n << 63n) : 0n) || value > (long ? (1n << 63n) - 1n : 4294967295n))
    throw new RangeError("Calendar value outside type range");
  const ns = value * calendarUnit(type);
  if ((type === "DATE" || type === "LDATE") && ns % dayNs !== 0n)
    throw new RangeError("Date must be a whole day");
  if ((type === "TOD" || type === "LTOD") && (ns < 0n || ns >= dayNs))
    throw new RangeError("Time of day must be within one day");
}
export function coerceCalendar(type: CalendarType, value: ScalarValue): number | string {
  let n = BigInt(value);
  if (type === "TOD" || type === "LTOD") n = modulo(n, dayNs / calendarUnit(type));
  validateCalendar(type, n);
  return type.startsWith("L") ? n.toString() : Number(n);
}

/** Parse without a locale or time zone, and reject the normalization of impossible dates. */
export function parseCalendar(type: CalendarType, literal: string): number | string {
  const text = literal.slice(literal.indexOf("#") + 1);
  const dateOnly = type === "DATE" || type === "LDATE";
  const timeOnly = type === "TOD" || type === "LTOD";
  const date = timeOnly ? undefined : /^(\d{4})-(\d{2})-(\d{2})(?:-|$)/.exec(text);
  let ns = 0n;
  if (!timeOnly) {
    if (!date) throw new RangeError("Invalid date");
    const year = Number(date[1]),
      month = Number(date[2]),
      day = Number(date[3]);
    const stamp = new Date(0);
    stamp.setUTCFullYear(year, month - 1, day);
    if (
      year < 1 ||
      stamp.getUTCFullYear() !== year ||
      stamp.getUTCMonth() !== month - 1 ||
      stamp.getUTCDate() !== day
    )
      throw new RangeError("Invalid date");
    ns = BigInt(stamp.getTime()) * 1000000n;
    if (dateOnly && text.length !== 10) throw new RangeError("Invalid date");
  }
  if (!dateOnly) {
    const time = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/.exec(timeOnly ? text : text.slice(11));
    if (!time || Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3]) > 59)
      throw new RangeError("Invalid time of day");
    ns +=
      BigInt(Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3])) * 1000000000n +
      BigInt((time[4] ?? "").padEnd(9, "0"));
  }
  const unit = calendarUnit(type);
  if (ns % unit !== 0n) throw new RangeError("Calendar literal exceeds type precision");
  const value = ns / unit;
  validateCalendar(type, value);
  return type.startsWith("L") ? value.toString() : Number(value);
}
export function formatCalendar(type: CalendarType, value: number | string): string {
  const ns = BigInt(value) * calendarUnit(type);
  const date = new Date(Number(floorDiv(ns, dayNs) * 86400000n)).toISOString().slice(0, 10);
  const timeNs = modulo(ns, dayNs);
  const seconds = timeNs / 1000000000n;
  const pad = (n: bigint) => n.toString().padStart(2, "0");
  const fraction = (timeNs % 1000000000n).toString().padStart(9, "0").replace(/0+$/, "");
  const time = `${pad(seconds / 3600n)}:${pad((seconds / 60n) % 60n)}:${pad(seconds % 60n)}${fraction ? `.${fraction}` : ""}`;
  return type === "DATE"
    ? `D#${date}`
    : type === "LDATE"
      ? `LDATE#${date}`
      : type === "TOD" || type === "LTOD"
        ? `${type}#${time}`
        : `${type}#${date}-${time}`;
}

/** All calendar arithmetic uses exact nanoseconds, quantizing only at the destination. */
export function calendarBinary(
  operator: string,
  leftType: CalendarType,
  left: ScalarValue,
  rightType: string,
  right: ScalarValue,
): ScalarValue {
  const a = BigInt(left) * calendarUnit(leftType);
  const b =
    BigInt(right) *
    (isCalendarType(rightType) ? calendarUnit(rightType) : rightType === "TIME" ? 1000000n : 1n);
  if (operator === "+" || operator === "-") {
    const ns = operator === "+" ? a + b : a - b;
    if (isCalendarType(rightType)) {
      const long = leftType.startsWith("L") || rightType.startsWith("L");
      return long ? BigInt.asIntN(64, ns).toString() : Number(BigInt.asIntN(32, ns / 1000000n));
    }
    const to =
      rightType === "LTIME" && !leftType.startsWith("L")
        ? (`L${leftType}` as CalendarType)
        : leftType;
    return coerceCalendar(to, floorDiv(ns, calendarUnit(to)));
  }
  switch (operator) {
    case "=":
      return a === b;
    case "<>":
      return a !== b;
    case "<":
      return a < b;
    case ">":
      return a > b;
    case "<=":
      return a <= b;
    case ">=":
      return a >= b;
    default:
      throw new RangeError("Invalid calendar operator");
  }
}
export function convertCalendar(
  from: CalendarType,
  to: CalendarType,
  value: ScalarValue,
): number | string {
  let ns = BigInt(value) * calendarUnit(from);
  if (to === "DATE" || to === "LDATE") ns = floorDiv(ns, dayNs) * dayNs;
  if (to === "TOD" || to === "LTOD") ns = modulo(ns, dayNs);
  return coerceCalendar(to, floorDiv(ns, calendarUnit(to)));
}

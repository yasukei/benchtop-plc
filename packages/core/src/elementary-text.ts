import { isCalendarType, parseCalendar } from "./calendar.js";
import { roundRational } from "./rounding.js";
import { integerRanges, isLongType, validateValue, type DataType } from "./values.js";

const digits = "[0-9]+(?:_[0-9]+)*";
const decimal = new RegExp(
  `^[+-]?${digits}(?:\\.${digits}(?:[eE][+-]?${digits})?|[eE][+-]?${digits})?$`,
);
const prefixes: Partial<Record<DataType, readonly string[]>> = {
  TIME: ["TIME", "T"],
  LTIME: ["LTIME", "LT"],
  DATE: ["DATE", "D"],
  TOD: ["TIME_OF_DAY", "TOD"],
  DT: ["DATE_AND_TIME", "DT"],
  LDATE: ["LDATE", "LD"],
  LTOD: ["LTIME_OF_DAY", "LTOD"],
  LDT: ["LDATE_AND_TIME", "LDT"],
};

/** Strict literal bodies, independent of compiler/DOM code and never wrapping on input. */
export function parseElementaryText(type: DataType, input: string): number | string | boolean {
  let text = input.trim();
  const prefix = /^([a-z_]+)#/i.exec(text);
  if (prefix) {
    if (!(prefixes[type] ?? [type]).includes(prefix[1]!.toUpperCase()))
      throw new RangeError("Wrong literal prefix");
    text = text.slice(prefix[0].length);
  }
  if (isCalendarType(type)) return parseCalendar(type, `${type}#${text}`);
  if (type === "TIME" || type === "LTIME") return parseDuration(type, text);
  if (type === "BOOL" && /^(TRUE|FALSE)$/i.test(text)) return text.toUpperCase() === "TRUE";
  const based = /^([+-]?)(2|16)#([0-9a-f]+(?:_[0-9a-f]+)*)$/i.exec(text);
  let n: bigint,
    d = 1n;
  if (based) {
    const body = based[3]!.replaceAll("_", "");
    if (based[2] === "2" && /[^01]/.test(body)) throw new RangeError("Invalid binary digit");
    n = BigInt(`${based[2] === "2" ? "0b" : "0x"}${body}`) * (based[1] === "-" ? -1n : 1n);
  } else {
    if (!decimal.test(text)) throw new RangeError("Invalid numeric text");
    if (type !== "REAL" && type !== "LREAL" && /[.eE]/.test(text))
      throw new RangeError("Expected integer literal");
    const parts = decimalFraction(text);
    n = parts.n;
    d = parts.d;
  }
  if (type === "REAL" || type === "LREAL") return roundRational({ n, d }, type);
  if (type === "BOOL") {
    if (n !== 0n && n !== 1n) throw new RangeError("BOOL outside range");
    return n === 1n;
  }
  if (!(type in integerRanges)) throw new RangeError("Expected elementary numeric type");
  const [min, max] = integerRanges[type as keyof typeof integerRanges];
  if (n < BigInt(min) || n > BigInt(max)) throw new RangeError("Value outside type range");
  const value = isLongType(type) ? n.toString() : Number(n);
  validateValue(type, value);
  return value;
}

function decimalFraction(text: string): { n: bigint; d: bigint } {
  const [mantissa = "0", exponent = "0"] = text.replaceAll("_", "").toLowerCase().split("e");
  const scale = Number(exponent) - (mantissa.split(".")[1]?.length ?? 0);
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 10000)
    throw new RangeError("Decimal scale exceeds evaluation budget");
  const n = BigInt(mantissa.replace(".", ""));
  return {
    n: scale >= 0 ? n * 10n ** BigInt(scale) : n,
    d: scale >= 0 ? 1n : 10n ** BigInt(-scale),
  };
}

function parseDuration(type: "TIME" | "LTIME", text: string): number | string {
  const units: Record<string, bigint> = {
    d: 86400000000000n,
    h: 3600000000000n,
    m: 60000000000n,
    s: 1000000000n,
    ms: 1000000n,
    us: 1000n,
    ns: 1n,
  };
  const body = text.replace(/^[+-]/, "");
  const pattern = new RegExp(`(${digits}(?:\\.${digits})?)(ms|us|ns|d|h|m|s)`, "gi");
  let end = 0,
    previous = 86400000000001n,
    fractional = false;
  let n = 0n,
    d = 1n;
  for (const part of body.matchAll(pattern)) {
    const unit = units[part[2]!.toLowerCase()]!;
    const separated = end > 0 && body[end] === "_" && part.index === end + 1;
    if (
      (part.index !== end && !separated) ||
      unit >= previous ||
      fractional ||
      (type === "TIME" && unit < 1000000n)
    )
      throw new RangeError("Invalid duration");
    const amount = decimalFraction(part[1]!);
    n = n * amount.d + amount.n * unit * d;
    d *= amount.d;
    previous = unit;
    fractional = part[1]!.includes(".");
    end = part.index + part[0].length;
  }
  if (end === 0 || end !== body.length) throw new RangeError("Invalid duration");
  if (text.startsWith("-")) n = -n;
  if (type === "TIME") d *= 1000000n;
  const [min, max] = integerRanges[type];
  if (n < BigInt(min) * d || n > BigInt(max) * d || (type === "LTIME" && n % d !== 0n))
    throw new RangeError("Duration outside type range");
  return type === "LTIME" ? (n / d).toString() : Number(n / d) || 0;
}

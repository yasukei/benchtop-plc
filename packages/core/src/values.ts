/** Elementary types through 32 bits. TIME is a signed 32-bit count of milliseconds. */
export interface ValueByType {
  BOOL: boolean;
  SINT: number;
  USINT: number;
  UDINT: number;
  BYTE: number;
  WORD: number;
  DWORD: number;
  INT: number;
  DINT: number;
  UINT: number;
  REAL: number;
  LREAL: number;
  TIME: number;
}

export type DataType = keyof ValueByType;
export const integerTypes = ["SINT", "USINT", "INT", "UINT", "DINT", "UDINT"] as const;
export type IntegerType = (typeof integerTypes)[number];
export type BitStringType = "BYTE" | "WORD" | "DWORD";
export type BitType = "BOOL" | BitStringType;
export const bitWidths = { BOOL: 1, BYTE: 8, WORD: 16, DWORD: 32 } as const;
export const integerWidths = { SINT: 8, USINT: 8, INT: 16, UINT: 16, DINT: 32, UDINT: 32 } as const;
export const integerRanges = {
  SINT: [-128, 127],
  USINT: [0, 255],
  INT: [-32768, 32767],
  UINT: [0, 65535],
  DINT: [-2147483648, 2147483647],
  UDINT: [0, 4294967295],
  BYTE: [0, 255],
  WORD: [0, 65535],
  DWORD: [0, 4294967295],
  TIME: [-2147483648, 2147483647],
} as const;
export const isIntegerType = (type: string): type is IntegerType =>
  integerTypes.some((item) => item === type);
export const isBitType = (type: string): type is BitType => Object.hasOwn(bitWidths, type);

/** External values are checked, never wrapped. Computed results use coerceValue. */
export function validateValue(dataType: DataType, value: unknown): void {
  if (dataType === "BOOL") {
    if (typeof value !== "boolean") throw new RangeError("Expected BOOL");
    return;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0))
    throw new RangeError("Expected a finite canonical number");
  if (dataType === "REAL" || dataType === "LREAL") {
    if (dataType === "REAL" && Math.fround(value) !== value)
      throw new RangeError("Expected binary32 value");
    return;
  }
  const [min, max] = integerRanges[dataType];
  if (!Number.isInteger(value) || value < min || value > max)
    throw new RangeError("Value outside type range");
}
export type NumericType = IntegerType | "REAL" | "LREAL";
export type ScalarValue = boolean | number;
export type TypedValue<T extends DataType = DataType> = {
  [K in T]: { dataType: K; value: ValueByType[K] };
}[T];

function finite(value: ScalarValue): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new RangeError("PLC values must be finite");
  return number || 0;
}

export function coerceBool(value: ScalarValue): boolean {
  return finite(value) !== 0;
}

export function coerceInt(value: ScalarValue): number {
  return (finite(value) << 16) >> 16;
}

export function coerceUint(value: ScalarValue): number {
  return finite(value) & 0xffff;
}

export function coerceDint(value: ScalarValue): number {
  return finite(value) | 0;
}

export function coerceReal(value: ScalarValue): number {
  return finite(Math.fround(finite(value)));
}

export function coerceLreal(value: ScalarValue): number {
  return finite(value);
}

export function coerceTime(value: ScalarValue): number {
  return coerceDint(value);
}

const coercers = {
  BOOL: coerceBool,
  SINT: (value: ScalarValue) => (finite(value) << 24) >> 24,
  USINT: (value: ScalarValue) => finite(value) & 0xff,
  UDINT: (value: ScalarValue) => finite(value) >>> 0,
  BYTE: (value: ScalarValue) => finite(value) & 0xff,
  WORD: coerceUint,
  DWORD: (value: ScalarValue) => finite(value) >>> 0,
  INT: coerceInt,
  DINT: coerceDint,
  UINT: coerceUint,
  REAL: coerceReal,
  LREAL: coerceLreal,
  TIME: coerceTime,
};

export function coerceValue<T extends DataType>(dataType: T, value: ScalarValue): ValueByType[T] {
  // The table preserves the key/result relationship, which indexed access otherwise loses.
  return coercers[dataType](value) as ValueByType[T];
}

export function formatTime(value: number): string {
  const milliseconds = coerceTime(value);
  let remaining = Math.abs(milliseconds);
  let parts = "";
  for (const [unit, size] of [
    ["d", 86_400_000],
    ["h", 3_600_000],
    ["m", 60_000],
    ["s", 1_000],
    ["ms", 1],
  ] as const) {
    const count = Math.floor(remaining / size);
    if (count !== 0) parts += `${count}${unit}`;
    remaining %= size;
  }
  return `T#${milliseconds < 0 ? "-" : ""}${parts || "0ms"}`;
}

/** Fewest significant digits that round back to the same finite binary32 value. */
function shortestReal(value: number): string {
  for (let precision = 1; precision < 9; precision++) {
    const candidate = Number(value.toPrecision(precision));
    if (Math.fround(candidate) === value) return String(candidate);
  }
  // Nine significant decimal digits suffice for every binary32 value.
  return String(Number(value.toPrecision(9)));
}

/** IEC value syntax, independent of the UI's language or locale. */
export function formatValue<T extends DataType>(dataType: T, value: ValueByType[T]): string {
  const coerced = coerceValue(dataType, value);
  if (dataType === "BOOL") return coerced ? "TRUE" : "FALSE";
  if (dataType === "TIME") return formatTime(Number(coerced));
  if (dataType === "BYTE" || dataType === "WORD" || dataType === "DWORD")
    return `16#${Number(coerced)
      .toString(16)
      .toUpperCase()
      .padStart(bitWidths[dataType as BitStringType] / 4, "0")}`;
  const text = dataType === "REAL" ? shortestReal(Number(coerced)) : String(coerced);
  if (dataType !== "REAL" && dataType !== "LREAL") return text;
  const [mantissa = "0", exponent] = text.split("e");
  const decimal = mantissa.includes(".") ? mantissa : `${mantissa}.0`;
  return exponent === undefined ? decimal : `${decimal}e${exponent}`;
}

/** Milestone 1 elementary types. TIME is measured in integer milliseconds. */
export interface ValueByType {
  BOOL: boolean;
  INT: number;
  DINT: number;
  UINT: number;
  REAL: number;
  LREAL: number;
  TIME: number;
}

export type DataType = keyof ValueByType;
export type IntegerType = "INT" | "DINT" | "UINT";
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
  // Normalize negative zero so JSON round trips preserve the value.
  return Math.trunc(finite(value)) || 0;
}

const coercers = {
  BOOL: coerceBool,
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

/** IEC value syntax, independent of the UI's language or locale. */
export function formatValue<T extends DataType>(dataType: T, value: ValueByType[T]): string {
  const coerced = coerceValue(dataType, value);
  if (dataType === "BOOL") return coerced ? "TRUE" : "FALSE";
  if (dataType === "TIME") return formatTime(Number(coerced));
  const text = String(coerced);
  if (dataType !== "REAL" && dataType !== "LREAL") return text;
  const [mantissa = "0", exponent] = text.split("e");
  const decimal = mantissa.includes(".") ? mantissa : `${mantissa}.0`;
  return exponent === undefined ? decimal : `${decimal}e${exponent}`;
}

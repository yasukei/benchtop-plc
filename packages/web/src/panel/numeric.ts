import {
  addressBytes,
  formatDirectAddress,
  addressTypes,
  parseDirectAddress,
  type DataType,
  type TypedValue,
} from "@benchtop-plc/core";
import { parseWrittenValue } from "../monitor.js";
interface NumericSettings {
  kind: string;
  address: string | null;
  dataType?: DataType;
  min?: number;
  max?: number;
}

export const panelNumericTypes = [
  ...addressTypes.B,
  ...addressTypes.W,
  ...addressTypes.D,
  ...addressTypes.L,
];

/** Keep decimal text intact until parsing, including exact 64-bit integer digits. */
export function parseNumericInput(part: NumericSettings, source: string): TypedValue | null {
  if (
    !part.dataType ||
    !panelNumericTypes.includes(part.dataType) ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(source)
  )
    return null;
  const value = parseWrittenValue(part.dataType, source);
  if (!value) return null;
  const n = typeof value.value === "string" ? BigInt(value.value) : Number(value.value);
  for (const [bound, minimum] of [
    [part.min, true],
    [part.max, false],
  ] as const) {
    if (bound === undefined) continue;
    const parsed = parseWrittenValue(part.dataType, String(bound));
    if (!parsed) return null;
    const limit = typeof parsed.value === "string" ? BigInt(parsed.value) : Number(parsed.value);
    if (minimum ? n < limit : n > limit) return null;
  }
  return value;
}
export function validNumericBounds(part: NumericSettings): boolean {
  if (part.kind !== "numericInput") return part.min === undefined && part.max === undefined;
  for (const bound of [part.min, part.max]) {
    if (
      bound !== undefined &&
      (typeof bound !== "number" ||
        !Number.isFinite(bound) ||
        !parseNumericInput({ ...part, min: undefined, max: undefined }, String(bound)))
    )
      return false;
  }
  return part.min === undefined || part.max === undefined || part.min < part.max;
}
export function assignNumericBounds<T extends NumericSettings>(
  part: T,
  min: string,
  max: string,
): T {
  const next = { ...part };
  delete next.min;
  delete next.max;
  for (const [key, source] of [
    ["min", min],
    ["max", max],
  ] as const) {
    if (source === "") continue;
    const parsed = parseNumericInput({ ...part, min: undefined, max: undefined }, source);
    const bound = Number(source);
    if (!parsed || (typeof parsed.value === "string" && BigInt(parsed.value) !== BigInt(bound)))
      throw new RangeError("Invalid numeric bound");
    next[key] = bound;
  }
  if (!validNumericBounds(next)) throw new RangeError("Invalid numeric bounds");
  return next;
}
/** A type chooses its address size; preserve the index if it still fits the area. */
export function assignNumericType<T extends NumericSettings>(part: T, dataType: DataType): T {
  const size = (["B", "W", "D", "L"] as const).find((size) =>
    addressTypes[size].includes(dataType),
  );
  if (!size || !part.address) throw new RangeError("Invalid numeric type");
  const current = parseDirectAddress(part.address)!;
  const index = Math.min("index" in current ? current.index : 0, 64 / addressBytes[size] - 1);
  const address = formatDirectAddress({ area: current.area, size, index });
  const next = { ...part, address, dataType };
  if (!validNumericBounds(next)) {
    delete next.min;
    delete next.max;
  }
  return next;
}

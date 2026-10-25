import type { DirectAddress, IoBit } from "./ir.js";
import { validateValue, type DataType, type TypedValue, type ScalarValue } from "./values.js";

export const areaBytes = { I: 64, Q: 64, M: 1024 } as const;
export const addressTypes: Record<DirectAddress["size"], readonly DataType[]> = {
  X: ["BOOL"],
  B: ["BYTE", "SINT", "USINT"],
  W: ["WORD", "INT", "UINT"],
  D: ["DWORD", "DINT", "UDINT", "REAL"],
  L: ["LWORD", "LINT", "ULINT", "LREAL"],
};
export const addressBytes = { X: 1, B: 1, W: 2, D: 4, L: 8 } as const;

/** Syntax only: the compiler reports area bounds separately. */
export function parseDirectAddress(text: string): DirectAddress | null {
  const match = /^%([IQM])(?:X([0-9]+)\.([0-9]+)|([BWDL])([0-9]+))$/i.exec(text);
  if (
    !match ||
    match
      .slice(2)
      .filter((v) => v !== undefined && /^[0-9]+$/.test(v))
      .some((v) => !Number.isSafeInteger(Number(v)))
  )
    return null;
  const area = match[1]!.toUpperCase() as DirectAddress["area"];
  if (match[2] !== undefined)
    return { area, size: "X", byte: Number(match[2]), bit: Number(match[3]) as IoBit };
  return { area, size: match[4]!.toUpperCase() as "B" | "W" | "D" | "L", index: Number(match[5]) };
}
export function addressOffset(address: DirectAddress): number {
  return address.size === "X" ? address.byte : address.index * addressBytes[address.size];
}
export function validDirectAddress(address: DirectAddress): boolean {
  const offset = addressOffset(address);
  return (
    Number.isSafeInteger(address.size === "X" ? address.byte : address.index) &&
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    offset + addressBytes[address.size] <= areaBytes[address.area] &&
    (address.size !== "X" ||
      (Number.isInteger(address.bit) && address.bit >= 0 && address.bit <= 7))
  );
}
export function formatDirectAddress(address: DirectAddress): string {
  return address.size === "X"
    ? `%${address.area}X${address.byte}.${address.bit}`
    : `%${address.area}${address.size}${address.index}`;
}
export function addressBinds(address: DirectAddress, type: unknown): type is DataType {
  return addressTypes[address.size].includes(type as DataType);
}
function view(bytes: readonly number[], address: DirectAddress, type: DataType): DataView {
  if (!validDirectAddress(address) || !addressBinds(address, type))
    throw new RangeError("Invalid direct address or type");
  const offset = addressOffset(address);
  if (offset + addressBytes[address.size] > bytes.length)
    throw new RangeError("Invalid area image");
  return new DataView(
    Uint8Array.from(bytes.slice(offset, offset + addressBytes[address.size])).buffer,
  );
}
/** Raw decoding can produce NaN/Infinity; program reads must validate the result. */
export function readDirectValue(
  bytes: readonly number[],
  address: DirectAddress,
  type: DataType,
): ScalarValue {
  const data = view(bytes, address, type);
  switch (type) {
    case "BOOL":
      return (data.getUint8(0) & (1 << (address as DirectAddress & { bit: IoBit }).bit)) !== 0;
    case "SINT":
      return data.getInt8(0);
    case "BYTE":
    case "USINT":
      return data.getUint8(0);
    case "INT":
      return data.getInt16(0, true);
    case "WORD":
    case "UINT":
      return data.getUint16(0, true);
    case "DINT":
      return data.getInt32(0, true);
    case "DWORD":
    case "UDINT":
      return data.getUint32(0, true);
    case "REAL": {
      const value = data.getFloat32(0, true);
      return value === 0 ? 0 : value;
    }
    case "LREAL": {
      const value = data.getFloat64(0, true);
      return value === 0 ? 0 : value;
    }
    case "LINT":
      return data.getBigInt64(0, true).toString();
    case "LWORD":
    case "ULINT":
      return data.getBigUint64(0, true).toString();
    default:
      throw new RangeError("Unsupported direct address type");
  }
}
export function writeDirectValue(bytes: number[], address: DirectAddress, value: TypedValue): void {
  const data = view(bytes, address, value.dataType);
  validateValue(value.dataType, value.value);
  const n = Number(value.value);
  switch (value.dataType) {
    case "BOOL": {
      if (address.size !== "X") throw new RangeError("Expected bit address");
      const mask = 1 << address.bit;
      data.setUint8(0, value.value ? data.getUint8(0) | mask : data.getUint8(0) & ~mask);
      break;
    }
    case "SINT":
      data.setInt8(0, n);
      break;
    case "BYTE":
    case "USINT":
      data.setUint8(0, n);
      break;
    case "INT":
      data.setInt16(0, n, true);
      break;
    case "WORD":
    case "UINT":
      data.setUint16(0, n, true);
      break;
    case "DINT":
      data.setInt32(0, n, true);
      break;
    case "DWORD":
    case "UDINT":
      data.setUint32(0, n, true);
      break;
    case "REAL":
      data.setFloat32(0, n, true);
      break;
    case "LREAL":
      data.setFloat64(0, n, true);
      break;
    case "LINT":
      data.setBigInt64(0, BigInt(value.value), true);
      break;
    case "LWORD":
    case "ULINT":
      data.setBigUint64(0, BigInt(value.value), true);
      break;
    default:
      throw new RangeError("Unsupported direct address type");
  }
  const offset = addressOffset(address);
  new Uint8Array(data.buffer).forEach((byte, i) => {
    bytes[offset + i] = byte;
  });
}
export function directBits(bytes: readonly number[], address: DirectAddress): string {
  return (
    "16#" +
    bytes
      .slice(addressOffset(address), addressOffset(address) + addressBytes[address.size])
      .reverse()
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}

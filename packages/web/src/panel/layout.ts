import { validNumericBounds } from "./numeric.js";
import {
  addressBinds,
  addressBytes,
  addressTypes,
  formatDirectAddress,
  parseDirectAddress,
  validDirectAddress,
  type DataType,
} from "@benchtop-plc/core";

export const partKinds = [
  "led",
  "pushbutton",
  "selector",
  "estop",
  "numericInput",
  "numericDisplay",
] as const;
export const ledColors = ["green", "amber", "red", "blue", "white"] as const;
export const buttonColors = ["green", "red", "yellow", "blue", "black", "white"] as const;
export type PartKind = (typeof partKinds)[number];
export type LedColor = (typeof ledColors)[number];
export type PartColor = LedColor | (typeof buttonColors)[number];
export function colorsFor(kind: PartKind): readonly PartColor[] {
  return kind === "pushbutton" || kind === "selector" ? buttonColors : ledColors;
}
export const partFootprint = { width: 56, height: 84 } as const;
// Fractional positions must leave enough space at the smallest supported canvas size.
export const minimumCanvasSize = { width: 300, height: 190 } as const;
export interface PanelSize {
  width: number;
  height: number;
}
export interface PanelPart {
  id: string;
  kind: PartKind;
  label: string;
  x: number;
  y: number;
  address: string | null;
  color: PartColor;
  dataType?: DataType;
  min?: number;
  max?: number;
}
export function isNumericPart(part: Pick<PanelPart, "kind">): boolean {
  return part.kind === "numericInput" || part.kind === "numericDisplay";
}
export function partSize(part: Pick<PanelPart, "kind">): PanelSize {
  return isNumericPart(part) ? { width: 144, height: 84 } : partFootprint;
}
export function panelAddresses(part: PanelPart): string[] {
  const area = part.kind === "led" || part.kind === "numericDisplay" ? "Q" : "I";
  if (!isNumericPart(part))
    return Array.from({ length: 512 }, (_, n) => `%${area}X${Math.floor(n / 8)}.${n % 8}`);
  const size = (["B", "W", "D", "L"] as const).find((size) =>
    addressTypes[size].includes(part.dataType!),
  );
  return size
    ? Array.from({ length: 64 / addressBytes[size] }, (_, n) => `%${area}${size}${n}`)
    : [];
}
export type PanelLayout = PanelPart[];
const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
export function addressFor(part: PanelPart): string {
  return part.address ?? "";
}
export function assignAddress(part: PanelPart, address: string): PanelPart {
  if (part.kind === "estop") return { ...part, address: null };
  const parsed = parseDirectAddress(address);
  if (
    !parsed ||
    (isNumericPart(part)
      ? parsed.size === "X" || !addressBinds(parsed, part.dataType)
      : parsed.size !== "X") ||
    !validDirectAddress(parsed) ||
    parsed.area !== (part.kind === "led" || part.kind === "numericDisplay" ? "Q" : "I")
  )
    throw new RangeError("Invalid panel address");
  return { ...part, address: formatDirectAddress(parsed) };
}
/** Search row by row using each part's footprint in edit and operate modes. */
export function findPartPosition(
  layout: PanelLayout,
  size: PanelSize,
  kind: PartKind = "led",
): { x: number; y: number } {
  if (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  ) {
    const footprint = partSize({ kind });
    const spacingX = partFootprint.width + 8;
    const spacingY = partFootprint.height + 8;
    for (let top = 0; top <= size.height; top += spacingY) {
      for (let left = 0; left <= size.width; left += spacingX) {
        if (
          layout.every(
            (part) =>
              Math.abs(part.x * size.width - left) >=
                (partSize(part).width + footprint.width) / 2 + 8 ||
              Math.abs(part.y * size.height - top) >= spacingY,
          )
        )
          return { x: left / size.width, y: top / size.height };
      }
    }
  }
  return { x: 0.5, y: 0.5 };
}
export function addPart(
  layout: PanelLayout,
  kind: PartKind,
  label: string,
  size: PanelSize = minimumCanvasSize,
): PanelLayout {
  if (kind === "estop" && layout.some((part) => part.kind === "estop")) return layout;
  let id = 1;
  while (layout.some((part) => part.id === String(id))) id++;
  const area = kind === "led" || kind === "numericDisplay" ? "Q" : "I";
  const used = layout.filter((part) => addressFor(part).startsWith(`%${area}`));
  const bit =
    Array.from({ length: 512 }, (_, bit) => bit).find(
      (bit) => !used.some((part) => part.address === `%${area}X${Math.floor(bit / 8)}.${bit % 8}`),
    ) ?? 0;
  return [
    ...layout,
    {
      id: String(id),
      kind,
      label,
      ...findPartPosition(layout, size, kind),
      address:
        kind === "estop"
          ? null
          : isNumericPart({ kind })
            ? `%${area}W0`
            : `%${area}X${Math.floor(bit / 8)}.${bit % 8}`,
      ...(isNumericPart({ kind }) ? { dataType: "INT" as const } : {}),
      color: "green",
    },
  ];
}
export function movePart(layout: PanelLayout, id: string, x: number, y: number): PanelLayout {
  return layout.map((part) => (part.id === id ? { ...part, x: clamp(x), y: clamp(y) } : part));
}
export function deletePart(layout: PanelLayout, id: string): PanelLayout {
  return layout.filter((part) => part.id !== id);
}
/** Validate untrusted project data before it reaches controls or styles. */
export function readLayout(value: unknown): PanelLayout | null {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  const parts: PanelLayout = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const p = item as Partial<PanelPart> & { bit?: number | null };
    const address =
      p.address !== undefined
        ? p.address
        : p.kind === "estop" && p.bit === null
          ? null
          : Number.isInteger(p.bit) && p.bit! >= 0 && p.bit! <= 7
            ? `%${p.kind === "led" ? "Q" : "I"}X0.${p.bit}`
            : undefined;
    const parsed = typeof address === "string" ? parseDirectAddress(address) : null;
    if (
      typeof p.id !== "string" ||
      ids.has(p.id) ||
      (typeof p.label !== "string" && !(isNumericPart(p as PanelPart) && p.label === undefined)) ||
      !partKinds.includes(p.kind!) ||
      !(
        (isNumericPart(p as PanelPart) && p.color === undefined) ||
        colorsFor(p.kind!).includes(p.color!) ||
        ((p.kind === "pushbutton" || p.kind === "selector") && p.color === "amber")
      ) ||
      typeof p.x !== "number" ||
      !Number.isFinite(p.x) ||
      p.x < 0 ||
      p.x > 1 ||
      typeof p.y !== "number" ||
      !Number.isFinite(p.y) ||
      p.y < 0 ||
      p.y > 1 ||
      (p.kind === "estop"
        ? address !== null
        : !parsed ||
          (isNumericPart(p as PanelPart)
            ? parsed.size === "X" || !addressBinds(parsed, p.dataType)
            : parsed.size !== "X") ||
          !validDirectAddress(parsed) ||
          parsed.area !== (p.kind === "led" || p.kind === "numericDisplay" ? "Q" : "I")) ||
      (isNumericPart(p as PanelPart) && !validNumericBounds(p as PanelPart))
    )
      return null;
    ids.add(p.id);
    parts.push({
      id: p.id,
      label: p.label ?? "",
      kind: p.kind!,
      color:
        (p.kind === "pushbutton" || p.kind === "selector") && p.color === "amber"
          ? "yellow"
          : (p.color ?? "green"),
      x: p.x,
      y: p.y,
      address: address === null ? null : formatDirectAddress(parsed!),
      ...(isNumericPart(p as PanelPart)
        ? {
            dataType: p.dataType!,
            ...(p.min === undefined ? {} : { min: p.min }),
            ...(p.max === undefined ? {} : { max: p.max }),
          }
        : {}),
    });
  }
  return parts.filter((p) => p.kind === "estop").length > 1 ? null : parts;
}

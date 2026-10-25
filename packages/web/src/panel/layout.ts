import { parseDirectAddress, validDirectAddress } from "@benchtop-plc/core";

export const partKinds = ["led", "pushbutton", "selector", "estop"] as const;
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
    parsed.size !== "X" ||
    !validDirectAddress(parsed) ||
    parsed.area !== (part.kind === "led" ? "Q" : "I")
  )
    throw new RangeError("Invalid panel address");
  return { ...part, address: address.toUpperCase() };
}
/** Search row by row using the same fixed footprint in edit and operate modes. */
export function findPartPosition(layout: PanelLayout, size: PanelSize): { x: number; y: number } {
  if (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  ) {
    const spacingX = partFootprint.width + 8;
    const spacingY = partFootprint.height + 8;
    for (let top = 0; top <= size.height; top += spacingY) {
      for (let left = 0; left <= size.width; left += spacingX) {
        if (
          layout.every(
            (part) =>
              Math.abs(part.x * size.width - left) >= spacingX ||
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
  const area = kind === "led" ? "Q" : "I";
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
      ...findPartPosition(layout, size),
      address: kind === "estop" ? null : `%${area}X${Math.floor(bit / 8)}.${bit % 8}`,
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
      typeof p.label !== "string" ||
      !partKinds.includes(p.kind!) ||
      !(
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
          parsed.size !== "X" ||
          !validDirectAddress(parsed) ||
          parsed.area !== (p.kind === "led" ? "Q" : "I"))
    )
      return null;
    ids.add(p.id);
    parts.push({
      id: p.id,
      label: p.label,
      kind: p.kind!,
      color:
        (p.kind === "pushbutton" || p.kind === "selector") && p.color === "amber"
          ? "yellow"
          : p.color!,
      x: p.x,
      y: p.y,
      address: address === null ? null : address!.toUpperCase(),
    });
  }
  return parts.filter((p) => p.kind === "estop").length > 1 ? null : parts;
}

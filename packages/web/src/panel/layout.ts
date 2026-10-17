import type { IoBit } from "@benchtop-plc/core";

export const partKinds = ["led", "pushbutton", "selector", "estop"] as const;
export const ledColors = ["green", "amber", "red", "blue", "white"] as const;
export type PartKind = (typeof partKinds)[number];
export type LedColor = (typeof ledColors)[number];
export interface PanelPart {
  id: string;
  kind: PartKind;
  label: string;
  x: number;
  y: number;
  bit: IoBit | null;
  color: LedColor;
}
export type PanelLayout = PanelPart[];
const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
export function addressFor(part: PanelPart): string {
  return part.bit === null ? "" : `%${part.kind === "led" ? "Q" : "I"}X0.${part.bit}`;
}
export function assignAddress(part: PanelPart, address: string): PanelPart {
  if (part.kind === "estop") return { ...part, bit: null };
  const match = /^%([IQ])X0\.([0-7])$/i.exec(address);
  if (!match || match[1]!.toUpperCase() !== (part.kind === "led" ? "Q" : "I"))
    throw new RangeError("Invalid panel address");
  return { ...part, bit: Number(match[2]) as IoBit };
}
export function addPart(layout: PanelLayout, kind: PartKind, label: string): PanelLayout {
  if (kind === "estop" && layout.some((part) => part.kind === "estop")) return layout;
  let id = 1;
  while (layout.some((part) => part.id === String(id))) id++;
  const area = kind === "led" ? "Q" : "I";
  const used = layout.filter((part) => addressFor(part).startsWith(`%${area}`));
  const bit =
    Array.from({ length: 8 }, (_, bit) => bit).find(
      (bit) => !used.some((part) => part.bit === bit),
    ) ?? 0;
  return [
    ...layout,
    {
      id: String(id),
      kind,
      label,
      x: 0.5,
      y: 0.5,
      bit: kind === "estop" ? null : (bit as IoBit),
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
    const p = item as Partial<PanelPart>;
    if (
      typeof p.id !== "string" ||
      ids.has(p.id) ||
      typeof p.label !== "string" ||
      !partKinds.includes(p.kind!) ||
      !ledColors.includes(p.color!) ||
      typeof p.x !== "number" ||
      !Number.isFinite(p.x) ||
      p.x < 0 ||
      p.x > 1 ||
      typeof p.y !== "number" ||
      !Number.isFinite(p.y) ||
      p.y < 0 ||
      p.y > 1 ||
      (p.kind === "estop" ? p.bit !== null : !Number.isInteger(p.bit) || p.bit! < 0 || p.bit! > 7)
    )
      return null;
    ids.add(p.id);
    parts.push({
      id: p.id,
      label: p.label,
      kind: p.kind!,
      color: p.color!,
      x: p.x,
      y: p.y,
      bit: p.bit!,
    });
  }
  return parts.filter((p) => p.kind === "estop").length > 1 ? null : parts;
}

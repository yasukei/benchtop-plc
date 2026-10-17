import { describe, expect, it } from "vitest";
import {
  addPart,
  addressFor,
  assignAddress,
  buttonColors,
  colorsFor,
  deletePart,
  findPartPosition,
  ledColors,
  movePart,
  partFootprint,
  readLayout,
  type PanelLayout,
} from "./layout.js";

describe("panel layout", () => {
  it("assigns input/output addresses, unique IDs, and at most one emergency stop", () => {
    let layout = addPart([], "led", "Running");
    layout = addPart(layout, "led", "Lamp");
    layout = addPart(layout, "pushbutton", "Start");
    layout = addPart(layout, "selector", "Mode");
    layout = addPart(layout, "estop", "Emergency");
    expect(layout.map(addressFor)).toEqual(["%QX0.0", "%QX0.1", "%IX0.0", "%IX0.1", ""]);
    expect(new Set(layout.map((p) => p.id)).size).toBe(5);
    expect(addPart(layout, "estop", "Duplicate")).toBe(layout);
    expect(addressFor(assignAddress(layout[0]!, "%QX0.7"))).toBe("%QX0.7");
    for (const address of ["%IX0.0", "%QX0.8", "%QX1.0", "bad"])
      expect(() => assignAddress(layout[0]!, address)).toThrow();
    expect(assignAddress(layout[4]!, "%IX0.0").bit).toBeNull();
  });
  it("moves with clamping, deletes only the target, and leaves prior layouts immutable", () => {
    const layout = addPart(addPart([], "led", "A"), "pushbutton", "B");
    const moved = movePart(layout, "1", -0.3, 2);
    expect(moved[0]).toMatchObject({ x: 0, y: 1 });
    expect(moved[1]).toBe(layout[1]);
    expect(layout[0]).toMatchObject({ x: 0, y: 0 });
    expect(movePart(layout, "1", 0.2, 0.8)[0]).toMatchObject({ x: 0.2, y: 0.8 });
    expect(deletePart(moved, "1")).toEqual([layout[1]]);
  });
  it("validates project layouts and rejects malformed data", () => {
    const layout = addPart([], "led", "A");
    expect(readLayout(layout)).toEqual(layout);
    for (const data of [
      null,
      {},
      [null],
      [{ ...layout[0], x: 2 }],
      [{ ...layout[0], bit: null }],
      [{ ...layout[0], color: "purple" }],
      [layout[0], layout[0]],
      [{ ...layout[0], x: NaN }],
    ])
      expect(readLayout(data)).toBeNull();
    const estop = addPart([], "estop", "Stop")[0]!;
    expect(readLayout([estop, { ...estop, id: "2" }])).toBeNull();
  });
});

describe("panel placement", () => {
  const size = { width: 256, height: 184 };
  it("searches left to right, then moves to the next row without mutating the layout", () => {
    let layout: PanelLayout = [];
    for (const kind of ["led", "pushbutton", "selector", "estop", "led", "pushbutton"] as const) {
      const before = structuredClone(layout);
      const next = addPart(layout, kind, "A long label", size);
      expect(layout).toEqual(before);
      layout = next;
    }
    expect(layout.map(({ x, y }) => [x, y])).toEqual([
      [0, 0],
      [0.25, 0],
      [0.5, 0],
      [0.75, 0],
      [1, 0],
      [0, 0.5],
    ]);
    for (const [index, part] of layout.entries())
      for (const other of layout.slice(index + 1))
        expect(
          Math.abs(part.x - other.x) * size.width >= partFootprint.width ||
            Math.abs(part.y - other.y) * size.height >= partFootprint.height,
        ).toBe(true);
  });
  it("avoids parts moved off the grid and reuses a deleted position", () => {
    const layout = movePart(addPart([], "selector", "A", size), "1", 0.1, 0.1);
    expect(findPartPosition(layout, size)).toEqual({ x: 0.5, y: 0 });
    expect(findPartPosition(deletePart(layout, "1"), size)).toEqual({ x: 0, y: 0 });
  });
  it("uses the supplied canvas dimensions", () => {
    const layout = addPart([], "led", "A");
    expect(findPartPosition(layout, { width: 128, height: 184 })).toEqual({ x: 0.5, y: 0 });
  });
  it("falls back to the centre when every grid position is occupied", () => {
    let layout: PanelLayout = [];
    for (let i = 0; i < 15; i++) layout = addPart(layout, "pushbutton", String(i), size);
    expect(findPartPosition(layout, size)).toEqual({ x: 0.5, y: 0.5 });
  });
  it.each([
    { width: 0, height: 0 },
    { width: NaN, height: 184 },
    { width: 128, height: Infinity },
  ])("falls back safely for unavailable canvas dimensions: %j", (size) => {
    expect(findPartPosition([], size)).toEqual({ x: 0.5, y: 0.5 });
  });
});

describe("panel palettes", () => {
  it("keeps the LED and input palettes separate", () => {
    expect(colorsFor("led")).toEqual(ledColors);
    expect(colorsFor("pushbutton")).toEqual(buttonColors);
    expect(colorsFor("selector")).toEqual(buttonColors);
  });
  for (const kind of ["led", "pushbutton", "selector"] as const) {
    it(`validates all colors for ${kind}`, () => {
      const part = addPart([], kind, "A")[0]!;
      for (const color of new Set([...ledColors, ...buttonColors, "purple"])) {
        const result = readLayout([{ ...part, color }]);
        if (kind !== "led" && color === "amber") expect(result?.[0]?.color).toBe("yellow");
        else if (colorsFor(kind).includes(color as typeof part.color))
          expect(result?.[0]?.color).toBe(color);
        else expect(result).toBeNull();
      }
    });
  }
});

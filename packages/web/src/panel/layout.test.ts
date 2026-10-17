import { describe, expect, it } from "vitest";
import { addPart, addressFor, assignAddress, deletePart, movePart, readLayout } from "./layout.js";

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
    expect(layout[0]).toMatchObject({ x: 0.5, y: 0.5 });
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

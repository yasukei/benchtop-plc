import { describe, expect, it } from "vitest";
import { standardFunctionBlocks } from "@benchtop-plc/core";
import type { FunctionBlockType, TypedValue } from "@benchtop-plc/core";
import { VirtualClock } from "./clock.js";
import { createStandardFunctionBlock } from "./standard-blocks.js";

function setup(type: FunctionBlockType) {
  const block = createStandardFunctionBlock(type);
  const clock = new VirtualClock();
  function scan(inputs: Record<string, TypedValue["value"]> = {}, advance = 0) {
    clock.advance(advance);
    for (const [name, value] of Object.entries(inputs)) {
      const index = standardFunctionBlocks[type].inputs.findIndex(([port]) => port === name);
      if (index < 0) throw new Error(`Unknown input ${name}`);
      block.inputs[index]!.value = value;
    }
    block.execute(clock.now());
    return block.outputs.map((port) => port.value);
  }
  return { block, clock, scan };
}

describe("standard timers with a virtual clock", () => {
  it("TON reaches Q at PT exactly, clamps ET, resets and starts a fresh delay", () => {
    const { scan } = setup("TON");
    expect(scan({ PT: 100 })).toEqual([false, 0]);
    expect(scan({ IN: true }, 5)).toEqual([false, 0]);
    expect(scan({}, 50)).toEqual([false, 50]);
    expect(scan({}, 49)).toEqual([false, 99]);
    expect(scan({}, 1)).toEqual([true, 100]);
    expect(scan({}, 500)).toEqual([true, 100]);
    expect(scan({ IN: false })).toEqual([false, 0]);
    expect(scan({ IN: true })).toEqual([false, 0]);
    expect(scan({}, 20)).toEqual([false, 20]);
    expect(scan({ IN: false })).toEqual([false, 0]);
    expect(scan({ IN: true }, 200)).toEqual([false, 0]);
  });

  it("TOF starts only on a falling edge and cancels a pending delay when IN returns", () => {
    const { scan } = setup("TOF");
    expect(scan({ PT: 100 })).toEqual([false, 0]);
    expect(scan({}, 200)).toEqual([false, 0]);
    expect(scan({ IN: true })).toEqual([true, 0]);
    expect(scan({ IN: false })).toEqual([true, 0]);
    expect(scan({}, 99)).toEqual([true, 99]);
    expect(scan({}, 1)).toEqual([false, 100]);
    expect(scan({}, 500)).toEqual([false, 100]);
    expect(scan({ IN: true })).toEqual([true, 0]);
    expect(scan({ IN: false })).toEqual([true, 0]);
    expect(scan({}, 40)).toEqual([true, 40]);
    expect(scan({ IN: true })).toEqual([true, 0]);
    expect(scan({}, 200)).toEqual([true, 0]);
    expect(scan({ IN: false })).toEqual([true, 0]);
  });

  it("TP keeps a fixed pulse despite falling/rising edges and waits for rearming", () => {
    const { scan } = setup("TP");
    expect(scan({ PT: 100 })).toEqual([false, 0]);
    expect(scan({ IN: true })).toEqual([true, 0]);
    expect(scan({ IN: false }, 30)).toEqual([true, 30]);
    expect(scan({ IN: true }, 30)).toEqual([true, 60]);
    expect(scan({}, 39)).toEqual([true, 99]);
    expect(scan({}, 1)).toEqual([false, 100]);
    expect(scan({}, 500)).toEqual([false, 100]);
    expect(scan({ IN: false })).toEqual([false, 0]);
    expect(scan({ IN: true })).toEqual([true, 0]);
  });

  it("TP finishes even with IN low and ignores a rising edge at the active pulse deadline", () => {
    const { scan } = setup("TP");
    expect(scan({ IN: true, PT: 10 })).toEqual([true, 0]);
    expect(scan({ IN: false }, 9)).toEqual([true, 9]);
    expect(scan({ IN: true }, 1)).toEqual([false, 10]);
    expect(scan({ IN: false })).toEqual([false, 0]);
    expect(scan({ IN: true })).toEqual([true, 0]);
    expect(scan({ IN: false }, 10)).toEqual([false, 0]);
    expect(scan({ IN: true })).toEqual([true, 0]);
  });

  it.each([0, -100])("treats PT=%s as zero without a pulse or delay", (PT) => {
    expect(setup("TON").scan({ IN: true, PT })).toEqual([true, 0]);
    const off = setup("TOF");
    expect(off.scan({ IN: true, PT })).toEqual([true, 0]);
    expect(off.scan({ IN: false })).toEqual([false, 0]);
    expect(setup("TP").scan({ IN: true, PT })).toEqual([false, 0]);
  });

  it.each(["TON", "TOF", "TP"] as const)(
    "%s samples PT while timing and latches completion until reset",
    (type) => {
      const { scan } = setup(type);
      scan({ IN: true, PT: 100 });
      if (type === "TOF") scan({ IN: false });
      expect(scan({ PT: 200 }, 100)).toEqual([type !== "TON", 100]);
      expect(scan({ PT: 120 }, 20)).toEqual([type === "TON", 120]);
      expect(scan({ PT: 500 })).toEqual([type === "TON", 500]);
    },
  );

  it("uses only scan-start time and keeps instance state independent", () => {
    const first = setup("TON");
    const second = setup("TON");
    first.scan({ IN: true, PT: 10 });
    second.scan({ PT: 10 });
    expect(first.scan({}, 9)).toEqual([false, 9]);
    expect(first.scan()).toEqual([false, 9]);
    expect(second.scan({}, 10)).toEqual([false, 0]);
    expect(first.scan({}, 1)).toEqual([true, 10]);
  });
});

describe("edge detectors", () => {
  it.each([false, true])("does not invent a first-scan edge from CLK=%s", (initial) => {
    const rise = setup("R_TRIG"),
      fall = setup("F_TRIG");
    expect(rise.scan({ CLK: initial })).toEqual([false]);
    expect(fall.scan({ CLK: initial })).toEqual([false]);
    expect(rise.scan({ CLK: !initial })).toEqual([!initial]);
    expect(fall.scan({ CLK: !initial })).toEqual([initial]);
    expect(rise.scan()).toEqual([false]);
    expect(fall.scan()).toEqual([false]);
    expect(rise.scan({ CLK: initial })).toEqual([initial]);
    expect(fall.scan({ CLK: initial })).toEqual([!initial]);
    expect(rise.scan()).toEqual([false]);
    expect(fall.scan()).toEqual([false]);
  });
});

describe("INT counters", () => {
  it.each([
    ["CTU", "CU", false, 1],
    ["CTD", "CD", true, -1],
  ] as const)("%s counts an initial TRUE once", (type, input, q, count) => {
    const { scan } = setup(type);
    expect(scan({ [input]: true, PV: 10 })).toEqual([q, count]);
    expect(scan()).toEqual([q, count]);
    scan({ [input]: false });
    expect(scan({ [input]: true })).toEqual([q, count * 2]);
  });

  it.each([
    ["CTU", "CU", "R", false, 0],
    ["CTD", "CD", "LD", false, 10],
  ] as const)(
    "%s gives reset/load priority over an initial TRUE",
    (type, input, control, q, count) => {
      const { scan } = setup(type);
      expect(scan({ [input]: true, [control]: true, PV: 10 })).toEqual([q, count]);
      expect(scan({ [control]: false })).toEqual([q, count]);
    },
  );

  it("CTU counts rising edges through PV, with reset priority and retained edge history", () => {
    const { scan } = setup("CTU");
    expect(scan({ PV: 2 })).toEqual([false, 0]);
    expect(scan({ CU: true })).toEqual([false, 1]);
    expect(scan()).toEqual([false, 1]);
    scan({ CU: false });
    expect(scan({ CU: true })).toEqual([true, 2]);
    scan({ CU: false });
    expect(scan({ CU: true })).toEqual([true, 3]);
    expect(scan({ R: true })).toEqual([false, 0]);
    expect(scan({ R: false })).toEqual([false, 0]);
    scan({ CU: false });
    expect(scan({ CU: true })).toEqual([false, 1]);
    expect(scan({ PV: 0, R: true })).toEqual([true, 0]);
    expect(scan({ PV: -1 })).toEqual([true, 0]);
  });

  it("CTD loads PV, reaches zero, counts negative and gives LD priority", () => {
    const { scan } = setup("CTD");
    expect(scan()).toEqual([true, 0]);
    expect(scan({ LD: true, CD: true, PV: 2 })).toEqual([false, 2]);
    expect(scan({ LD: false })).toEqual([false, 2]);
    scan({ CD: false });
    expect(scan({ CD: true })).toEqual([false, 1]);
    expect(scan()).toEqual([false, 1]);
    scan({ CD: false });
    expect(scan({ CD: true })).toEqual([true, 0]);
    scan({ CD: false });
    expect(scan({ CD: true })).toEqual([true, -1]);
    expect(scan({ LD: true, PV: -20 })).toEqual([true, -20]);
    expect(scan({ PV: 0 })).toEqual([true, 0]);
  });

  it("CTU saturates at INT_MAX rather than wrapping or stopping at PV", () => {
    const { scan } = setup("CTU");
    scan({ PV: 1 });
    for (let count = 1; count <= 32769; count++) {
      scan({ CU: false });
      const result = scan({ CU: true });
      if (count >= 32766) expect(result).toEqual([true, Math.min(count, 32767)]);
    }
    expect(scan({ R: true })).toEqual([false, 0]);
  });

  it("CTD saturates at INT_MIN, including after loading either INT boundary", () => {
    const { scan } = setup("CTD");
    expect(scan({ LD: true, PV: 32767 })).toEqual([false, 32767]);
    scan({ LD: false, CD: false });
    expect(scan({ CD: true })).toEqual([false, 32766]);
    expect(scan({ LD: true, PV: -32767 })).toEqual([true, -32767]);
    scan({ LD: false, CD: false });
    expect(scan({ CD: true })).toEqual([true, -32768]);
    scan({ CD: false });
    expect(scan({ CD: true })).toEqual([true, -32768]);
    expect(scan({ LD: true, PV: -32768 })).toEqual([true, -32768]);
  });
});

describe("typed counter saturation", () => {
  const limits = [
    ["INT", -32768n, 32767n],
    ["DINT", -2147483648n, 2147483647n],
    ["LINT", -(1n << 63n), (1n << 63n) - 1n],
    ["UDINT", 0n, 4294967295n],
    ["ULINT", 0n, (1n << 64n) - 1n],
  ] as const;
  it.each(limits)("CTU_%s stops at its maximum and resets", (type, _min, max) => {
    const { block, scan } = setup(`CTU_${type}`);
    const value = (n: bigint) => (type === "LINT" || type === "ULINT" ? String(n) : Number(n));
    // Initialize the public CV state near the boundary instead of executing billions of edges.
    block.outputs[1]!.value = value(max - 1n);
    expect(scan({ CU: true, PV: value(1n) })).toEqual([true, value(max)]);
    scan({ CU: false });
    expect(scan({ CU: true })).toEqual([true, value(max)]);
    expect(scan({ R: true })).toEqual([false, value(0n)]);
  });
  it.each(limits)("CTD_%s stops at its minimum after loading PV", (type, min) => {
    const { scan } = setup(`CTD_${type}`);
    const value = (n: bigint) => (type === "LINT" || type === "ULINT" ? String(n) : Number(n));
    scan({ LD: true, PV: value(min + 1n) });
    expect(scan({ LD: false, CD: true })).toEqual([true, value(min)]);
    scan({ CD: false });
    expect(scan({ CD: true })).toEqual([true, value(min)]);
  });
});

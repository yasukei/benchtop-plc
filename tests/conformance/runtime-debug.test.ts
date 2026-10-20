import { describe, expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import type { IoImage, RuntimeSnapshot, TypedValue } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function setup(declarations: string, body: string) {
  const result = compile(`PROGRAM DebugTest VAR ${declarations} END_VAR ${body} END_PROGRAM`);
  expect(result.diagnostics).toEqual([]);
  if (!result.ir) throw new Error("Expected compiled IR");
  const clock = new VirtualClock();
  const inputs: IoImage = [false, false, false, false, false, false, false, false];
  const published: IoImage[] = [];
  const runtime = createRuntime({
    clock,
    ticker: new VirtualTicker(clock),
    stages: {
      readInputs: () => inputs,
      writeOutputs: (image) => published.push(image),
    },
  });
  runtime.load(result.ir);
  const value = (index = 0, snapshot: RuntimeSnapshot = runtime.snapshot()) => {
    const cell = snapshot.variables[index];
    if (cell?.kind !== "scalar") throw new Error("Expected scalar variable");
    return cell.value;
  };
  return { runtime, clock, inputs, published, value, ir: result.ir };
}

describe("runtime debug conformance", () => {
  it("forces input before execution and output after execution, then restores program control", () => {
    const { runtime, clock, value } = setup(
      "i AT %IX0.0 : BOOL; q AT %QX0.0 : BOOL; seen : BOOL;",
      "seen := i; q := FALSE;",
    );
    runtime.force(0, { dataType: "BOOL", value: true });
    runtime.force(1, { dataType: "BOOL", value: true });
    runtime.run();
    clock.advance(30);
    expect(value(0)).toBe(true);
    expect(value(1)).toBe(true);
    expect(value(2)).toBe(true);
    expect(runtime.snapshot()).toMatchObject({
      scanCount: 3,
      inputs: [false, false, false, false, false, false, false, false],
      outputs: [true, false, false, false, false, false, false, false],
      forced: [0, 1],
    });
    runtime.force(0, null);
    runtime.force(1, null);
    runtime.force(1, null);
    clock.advance(10);
    expect(value(0)).toBe(false);
    expect(value(1)).toBe(false);
    expect(value(2)).toBe(false);
    expect(runtime.snapshot().forced).toEqual([]);
    expect(runtime.snapshot().outputs[0]).toBe(false);
  });

  it("writes immediately in STOP and only once at the next scan boundary in RUN", () => {
    const { runtime, clock, value } = setup("n : INT;", "n := n + 1;");
    runtime.write(0, { dataType: "INT", value: 10 });
    expect(value()).toBe(10);
    expect(runtime.snapshot().scanCount).toBe(0);
    runtime.run();
    const write: TypedValue = { dataType: "INT", value: 20 };
    runtime.write(0, write);
    write.value = 999;
    expect(value()).toBe(10);
    clock.advance(9);
    expect(value()).toBe(10);
    clock.advance(1);
    expect(value()).toBe(21);
    clock.advance(20);
    expect(value()).toBe(23);
    runtime.write(0, { dataType: "INT", value: 30 });
    runtime.write(0, { dataType: "INT", value: 40 });
    clock.advance(10);
    expect(value()).toBe(41);
  });

  it("gives forces priority over writes and keeps a copied, validated force until cleared", () => {
    const { runtime, clock, value } = setup("n : INT;", "n := n + 1;");
    expect(() => runtime.force(0, { dataType: "INT", value: 32768 })).toThrow(
      "runtime.debug-value",
    );
    const force: TypedValue = { dataType: "INT", value: -32768 };
    runtime.force(0, force);
    force.value = 1;
    runtime.run();
    runtime.write(0, { dataType: "INT", value: 100 });
    clock.advance(20);
    expect(value()).toBe(-32768);
    runtime.force(0, { dataType: "INT", value: 20 });
    clock.advance(10);
    expect(value()).toBe(20);
    runtime.force(0, null);
    clock.advance(10);
    expect(value()).toBe(21);
  });

  it("rejects input writes, FB targets, invalid IDs, mismatched types and non-finite values atomically", () => {
    const { runtime } = setup("i AT %IX0.0 : BOOL; n : INT; timer : TON;", "");
    for (const running of [false, true]) {
      if (running) runtime.run();
      const before = runtime.snapshot();
      expect(() => runtime.write(0, { dataType: "BOOL", value: true })).toThrow("input-mapped");
      for (const variable of [-1, 0.5, NaN, Infinity, 2, 3]) {
        expect(() => runtime.force(variable, { dataType: "INT", value: 1 })).toThrow();
        expect(() => runtime.force(variable, null)).toThrow();
        expect(() => runtime.write(variable, { dataType: "INT", value: 1 })).toThrow();
      }
      for (const command of ["force", "write"] as const) {
        expect(() => runtime[command](1, { dataType: "BOOL", value: true })).toThrow(
          "runtime.debug-type-mismatch",
        );
        expect(() => runtime[command](1, { dataType: "INT", value: NaN })).toThrow(
          "runtime.debug-value",
        );
        expect(() => runtime[command](1, { dataType: "INT", value: Infinity })).toThrow(
          "runtime.debug-value",
        );
      }
      expect(runtime.snapshot()).toEqual(before);
      expect(runtime.diagnostic).toBeNull();
    }
  });

  it("preserves pending writes across rejected debug commands without latching a fault", () => {
    const { runtime, clock, value } = setup("n : INT; i AT %IX0.0 : BOOL;", "n := n + 1;");
    runtime.run();
    runtime.write(0, { dataType: "INT", value: 20 });
    expect(() => runtime.write(1, { dataType: "BOOL", value: true })).toThrow(
      "runtime.write-input-mapped",
    );
    expect(() => runtime.force(0, { dataType: "BOOL", value: true })).toThrow(
      "runtime.debug-type-mismatch",
    );
    expect(runtime.state).toBe("RUN");
    expect(runtime.diagnostic).toBeNull();
    clock.advance(10);
    expect(value()).toBe(21);
    clock.advance(10);
    expect(value()).toBe(22);
  });

  it("steps exactly once in STOP with clock-based FB time, and ignores RUN, FAULT and ESTOP", () => {
    const { runtime, clock, value } = setup(
      "n : INT; timer : TON; elapsed : TIME;",
      "n := n + 1; timer(IN := TRUE, PT := T#10ms); elapsed := timer.ET;",
    );
    expect(runtime.step().scanCount).toBe(1);
    expect(value(2)).toBe(0);
    clock.advance(10);
    expect(runtime.step().scanCount).toBe(2);
    expect(value(2)).toBe(10);
    expect(runtime.state).toBe("STOP");
    runtime.run();
    expect(runtime.step().scanCount).toBe(2);
    clock.advance(10);
    expect(runtime.snapshot().scanCount).toBe(3);
    runtime.setEmergencyStop(true);
    expect(runtime.step().scanCount).toBe(3);
    runtime.setEmergencyStop(false);
    const faulty = compile("PROGRAM Fault VAR n : INT; END_VAR n := 1 / n; END_PROGRAM");
    if (!faulty.ir) throw new Error("Expected faulty IR");
    runtime.load(faulty.ir);
    expect(runtime.step().scanCount).toBe(1);
    expect(runtime.state).toBe("FAULT");
    expect(runtime.step().scanCount).toBe(1);
  });

  it.each(["stop", "estop", "fault"] as const)(
    "keeps forced and written outputs OFF in %s",
    (state) => {
      const { runtime, clock, published, value } = setup(
        "q AT %QX0.0 : BOOL; n : INT;",
        state === "fault" ? "q := TRUE; n := 1 / n;" : "q := TRUE;",
      );
      runtime.force(0, { dataType: "BOOL", value: true });
      runtime.run();
      clock.advance(10);
      if (state === "stop") runtime.stop();
      if (state === "estop") runtime.setEmergencyStop(true);
      runtime.write(0, { dataType: "BOOL", value: true });
      runtime.step();
      expect(value()).toBe(false);
      expect(runtime.snapshot().outputs.every((bit) => !bit)).toBe(true);
      expect(published.at(-1)?.every((bit) => !bit)).toBe(true);
      expect(runtime.snapshot().forced).toEqual([0]);
    },
  );

  it.each(["coldReset", "load"] as const)("clears forces and queued writes on %s", (reset) => {
    const { runtime, clock, value, ir } = setup("n : INT;", "n := n + 1;");
    runtime.force(0, { dataType: "INT", value: 20 });
    runtime.run();
    runtime.write(0, { dataType: "INT", value: 100 });
    if (reset === "load") runtime.load(ir);
    else runtime.coldReset();
    expect(runtime.snapshot()).toMatchObject({ forced: [], scanCount: 0 });
    runtime.run();
    clock.advance(10);
    expect(value()).toBe(1);
  });

  it("lets a stopped write replace a queued write and detaches all snapshot data", () => {
    const { runtime, clock, inputs, value } = setup(
      "n : INT; i AT %IX0.0 : BOOL; timer : TON;",
      "n := n + 1; timer(IN := i, PT := T#10ms);",
    );
    runtime.run();
    runtime.write(0, { dataType: "INT", value: 10 });
    runtime.stop();
    runtime.write(0, { dataType: "INT", value: 20 });
    runtime.force(1, { dataType: "BOOL", value: true });
    clock.advance(5);
    runtime.step();
    expect(value()).toBe(21);
    clock.advance(10);
    const snapshot = runtime.step();
    expect(snapshot.variables[2]).toMatchObject({ outputs: [{ value: true }, { value: 10 }] });
    const expected = structuredClone(snapshot);
    snapshot.inputs[0] = true;
    snapshot.outputs[0] = true;
    snapshot.forced.length = 0;
    const block = snapshot.variables[2];
    if (block?.kind !== "functionBlock") throw new Error("Expected FB");
    block.inputs[0]!.value = false;
    block.outputs[0]!.value = false;
    const scalar = snapshot.variables[0];
    if (scalar?.kind !== "scalar") throw new Error("Expected scalar");
    scalar.value = 999;
    inputs[0] = true;
    expect(runtime.snapshot()).toEqual(expected);
    expect(JSON.parse(JSON.stringify(expected))).toEqual(expected);
  });
});

import { describe, expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import type { RuntimeSnapshot, ScalarValue, VariableSnapshot } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";
import type { ScanMemory } from "@benchtop-plc/runtime";

function setup(declarations: string, body: string) {
  const result = compile(`PROGRAM StandardTest VAR ${declarations} END_VAR ${body} END_PROGRAM`);
  expect(result.diagnostics).toEqual([]);
  if (!result.ir) throw new Error("Expected compiled IR");
  const ir = result.ir;
  const clock = new VirtualClock();
  let writes: Record<string, ScalarValue> = {};
  const runtime = createRuntime({
    clock,
    ticker: new VirtualTicker(clock),
    stages: {
      applyPendingWrites(memory: ScanMemory) {
        for (const [name, value] of Object.entries(writes)) {
          const index = ir.variables.findIndex((variable) => variable.name === name);
          if (index < 0) throw new Error(`Unknown variable ${name}`);
          memory.write(index, value);
        }
      },
    },
  });
  runtime.load(ir);
  function values(snapshot: RuntimeSnapshot = runtime.snapshot()) {
    return Object.fromEntries(
      ir.variables.map((variable, index): [string, ScalarValue | VariableSnapshot] => {
        const value = snapshot.variables[index]!;
        return [variable.name, value.kind === "scalar" ? value.value : value];
      }),
    );
  }
  function scan(inputs: Record<string, ScalarValue> = {}, advance = 0) {
    writes = inputs;
    clock.advance(advance);
    const snapshot = runtime.scanOnce();
    expect(runtime.diagnostic).toBeNull();
    return values(snapshot);
  }
  return { runtime, clock, scan, values };
}

describe("standard-library ST conformance", () => {
  it.each([
    [
      "TON",
      [
        [false, 0],
        [false, 9],
        [true, 10],
      ],
    ],
    [
      "TOF",
      [
        [true, 0],
        [true, 9],
        [false, 10],
      ],
    ],
    [
      "TP",
      [
        [true, 0],
        [true, 9],
        [false, 10],
      ],
    ],
  ] as const)(
    "executes compiled %s at PT-1 and PT with descriptor-indexed members",
    (type, expected) => {
      const { scan, runtime } = setup(
        `timer : ${type}; input : BOOL; q : BOOL; elapsed : TIME;`,
        "timer(IN := input, PT := T#10ms); q := timer.Q; elapsed := timer.ET;",
      );
      if (type === "TOF") scan({ input: true });
      const input = type !== "TOF";
      for (const [index, advance] of [0, 9, 1].entries()) {
        const state = scan({ input }, advance);
        expect([state.q, state.elapsed]).toEqual(expected[index]);
      }
      expect(
        runtime.snapshot().annotations[1]?.some((annotation) => annotation.values.length === 2),
      ).toBe(true);
      runtime.coldReset();
      expect(runtime.snapshot().variables[0]).toMatchObject({
        inputs: [
          { dataType: "BOOL", value: false },
          { dataType: "TIME", value: 0 },
        ],
        outputs: [
          { dataType: "BOOL", value: false },
          { dataType: "TIME", value: 0 },
        ],
      });
      expect(scan({ input: true }).elapsed).toBe(0);
    },
  );

  it("retains omitted inputs, supports input assignments and resets independent timer instances", () => {
    const { scan, runtime } = setup(
      "a, b : TON; enable : BOOL; qa, qb : BOOL; ea, eb : TIME;",
      `a.IN := enable; a.PT := T#10ms; a();
       b(IN := TRUE, PT := T#20ms); b();
       qa := a.Q; qb := b.Q; ea := a.ET; eb := b.ET;`,
    );
    expect(scan({ enable: true })).toMatchObject({ qa: false, qb: false, ea: 0, eb: 0 });
    expect(scan({}, 10)).toMatchObject({ qa: true, qb: false, ea: 10, eb: 10 });
    expect(scan({ enable: false }, 10)).toMatchObject({ qa: false, qb: true, ea: 0, eb: 20 });
    runtime.coldReset();
    expect(scan({ enable: true })).toMatchObject({ qa: false, qb: false, ea: 0, eb: 0 });
  });

  it("coerces an INT function result before widening its assignment to DINT", () => {
    const { scan } = setup("n : INT := -32768; result : DINT;", "result := ABS(n);");
    expect(scan().result).toBe(-32768);
  });

  it("suppresses initial trigger pulses and clears trigger history on cold reset", () => {
    const { scan, runtime } = setup(
      "r : R_TRIG; f : F_TRIG; input : BOOL; qr, qf : BOOL;",
      "r(CLK := input); f(CLK := input); qr := r.Q; qf := f.Q;",
    );
    expect(scan({ input: true })).toMatchObject({ qr: false, qf: false });
    expect(scan({ input: false })).toMatchObject({ qr: false, qf: true });
    expect(scan()).toMatchObject({ qr: false, qf: false });
    expect(scan({ input: true })).toMatchObject({ qr: true, qf: false });
    runtime.coldReset();
    expect(scan({ input: false })).toMatchObject({ qr: false, qf: false });
  });

  it("counts and loads through compiler-resolved counter ports and clears private CV on reset", () => {
    const { scan, runtime } = setup(
      "up : CTU; down : CTD; edge, reset, load : BOOL; u, d : INT; qu, qd : BOOL;",
      `up(CU := edge, R := reset, PV := 2); down(CD := edge, LD := load, PV := 2);
       u := up.CV; d := down.CV; qu := up.Q; qd := down.Q;`,
    );
    expect(scan({ load: true })).toMatchObject({ u: 0, d: 2, qu: false, qd: false });
    expect(scan({ load: false, edge: true })).toMatchObject({ u: 1, d: 1, qu: false, qd: false });
    expect(scan()).toMatchObject({ u: 1, d: 1 });
    scan({ edge: false });
    expect(scan({ edge: true })).toMatchObject({ u: 2, d: 0, qu: true, qd: true });
    expect(scan({ reset: true, load: true })).toMatchObject({ u: 0, d: 2 });
    runtime.coldReset();
    expect(scan()).toMatchObject({ u: 0, d: 0, qu: false, qd: true });
  });

  it("counts an initially high counter input once after load and cold reset while R_TRIG stays quiet", () => {
    const { scan, runtime } = setup(
      "up : CTU; down : CTD; trig : R_TRIG; sensor : BOOL; u, d : INT; pulse : BOOL;",
      `up(CU := sensor, R := FALSE, PV := 10); down(CD := sensor, LD := FALSE, PV := 10);
       trig(CLK := sensor); u := up.CV; d := down.CV; pulse := trig.Q;`,
    );
    expect(scan({ sensor: true })).toMatchObject({ u: 1, d: -1, pulse: false });
    expect(scan()).toMatchObject({ u: 1, d: -1, pulse: false });
    scan({ sensor: false });
    expect(scan({ sensor: true })).toMatchObject({ u: 2, d: -2, pulse: true });
    runtime.coldReset();
    expect(scan({ sensor: true })).toMatchObject({ u: 1, d: -1, pulse: false });
    expect(scan()).toMatchObject({ u: 1, d: -1, pulse: false });
  });

  it.each([
    ["INT", "ABS(-32768)", -32768],
    ["DINT", "ABS(-2147483648)", -2147483648],
    ["INT", "MIN(3, -2, 1)", -2],
    ["REAL", "MAX(3, 4.5, -2)", 4.5],
    ["INT", "LIMIT(0, -5, 10)", 0],
    ["REAL", "LIMIT(0.5, 20, 10)", 10],
    ["BOOL", "SEL(FALSE, TRUE, FALSE)", true],
    ["TIME", "SEL(TRUE, T#1s, T#2s)", 2000],
    ["REAL", "SEL(TRUE, 1, 2.5)", 2.5],
    ["INT", "REAL_TO_INT(2.5)", 2],
    ["INT", "REAL_TO_INT(-2.5)", -2],
    ["INT", "REAL_TO_INT(32767.5)", -32768],
    ["REAL", "INT_TO_REAL(-12)", -12],
    ["INT", "TIME_TO_INT(T#32768ms)", -32768],
    ["TIME", "INT_TO_TIME(-12)", -12],
    ["INT", "BOOL_TO_INT(TRUE)", 1],
    ["INT", "BOOL_TO_INT(FALSE)", 0],
  ])("executes %s result from %s with IR result coercion", (type, expression, expected) => {
    const { scan } = setup(`result : ${type};`, `result := ${expression};`);
    expect(scan().result).toBe(expected);
  });

  it("reports non-finite conversion results as a source-spanned runtime fault", () => {
    const { runtime } = setup("result : INT;", "result := REAL_TO_INT(1.0e39);");
    runtime.scanOnce();
    expect(runtime.state).toBe("FAULT");
    expect(runtime.diagnostic).toMatchObject({ code: "runtime.invalid-value", span: { line: 1 } });
  });
});

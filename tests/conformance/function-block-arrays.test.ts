import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function setup(sources: string[]) {
  const compiled = compileProject(sources);
  expect(compiled.diagnostics).toEqual([]);
  const ir = structuredClone(compiled.ir!);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  runtime.watch(ir.variables.map((_, i) => i));
  const id = (name: string) => ir.variables.findIndex((v) => v.key === name.toUpperCase());
  const value = (name: string) => snapshotVariable(runtime.snapshot(), id(name));
  return { clock, runtime, value, id, ir };
}

it("traces four independent TON elements called in a FOR loop with different presets", () => {
  const { runtime, clock, value } = setup([
    `PROGRAM Main VAR
    t : ARRAY[1..4] OF TON; presets : ARRAY[1..4] OF TIME := [T#10ms,T#20ms,T#30ms,T#40ms];
    done : ARRAY[1..4] OF BOOL; run : BOOL := TRUE; i : INT; END_VAR
    FOR i := 1 TO 4 DO t[i](IN := run, PT := presets[i], Q => done[i]); END_FOR;
    END_PROGRAM`,
  ]);
  const trace = [];
  for (let scan = 0; scan < 5; scan++) {
    runtime.step();
    expect(runtime.diagnostic).toBeNull();
    trace.push(
      [1, 2, 3, 4].map((i) => {
        expect(value(`t[${i}]`)).toMatchObject({
          kind: "functionBlock",
          outputs: [{ value: scan >= i }, { value: Math.min(scan * 10, i * 10) }],
        });
        const cell = value(`done[${i}]`);
        return cell?.kind === "scalar" && cell.value;
      }),
    );
    clock.advance(10);
  }
  expect(trace).toEqual([
    [false, false, false, false],
    [true, false, false, false],
    [true, true, false, false],
    [true, true, true, false],
    [true, true, true, true],
  ]);
});

it("preserves separate user element state through STOP/RUN and resets each nested timer", () => {
  const { runtime, clock, value, id } = setup([
    `PROGRAM Main VAR m : ARRAY[1..2] OF MotorStarter; i : INT; seen : BOOL; END_VAR
    m[1].enable := TRUE; m[2].enable := FALSE;
    seen := m[2].running;
    FOR i := 1 TO 2 DO m[i](); END_FOR;
    END_PROGRAM`,
    `FUNCTION_BLOCK MotorStarter VAR_INPUT enable : BOOL; END_VAR
    VAR_OUTPUT running : BOOL; END_VAR
    VAR delay : TON; calls : INT; END_VAR
    delay(IN := enable, PT := T#20ms, Q => running); calls := calls + 1;
    END_FUNCTION_BLOCK`,
  ]);
  runtime.step();
  clock.advance(10);
  runtime.run();
  runtime.stop();
  runtime.step();
  expect(value("M[1].DELAY")).toMatchObject({ outputs: [{ value: false }, { value: 10 }] });
  clock.advance(10);
  runtime.step();
  expect(value("M[1].RUNNING")).toMatchObject({ value: true });
  expect(value("M[2].RUNNING")).toMatchObject({ value: false });
  expect(value("M[1].CALLS")).toMatchObject({ value: 3 });
  runtime.force(id("M[2].RUNNING"), { dataType: "BOOL", value: true });
  runtime.step();
  expect(value("seen")).toMatchObject({ value: true });
  runtime.force(id("M[2].RUNNING"), null);
  runtime.coldReset();
  for (const i of [1, 2]) {
    expect(value(`M[${i}].CALLS`)).toMatchObject({ value: 0 });
    expect(value(`M[${i}].DELAY`)).toMatchObject({ outputs: [{ value: false }, { value: 0 }] });
  }
  runtime.step();
  expect(value("M[1].RUNNING")).toMatchObject({ value: false });
  clock.advance(20);
  runtime.step();
  expect(value("M[1].RUNNING")).toMatchObject({ value: true });
});

it("checks the instance index once before evaluating inputs, even when inputs mutate it", () => {
  const { runtime, value } = setup([
    `PROGRAM Main VAR t : ARRAY[1..2] OF TON; i : INT := 1; done : BOOL; END_VAR
    t[i](IN := Change(n := i), PT := T#0ms, Q => done); END_PROGRAM`,
    `FUNCTION Change : BOOL VAR_IN_OUT n : INT; END_VAR n := n + 1; Change := TRUE; END_FUNCTION`,
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("i")).toMatchObject({ value: 2 });
  expect(value("t[1]")).toMatchObject({ inputs: [{ value: true }, { value: 0 }] });
  expect(value("t[2]")).toMatchObject({ inputs: [{ value: false }, { value: 0 }] });
});

it("faults before input side effects on an out-of-bounds call and names its path", () => {
  const { runtime, value } = setup([
    `PROGRAM Main VAR t : ARRAY[1..4] OF TON; i : INT := 5; count : INT; END_VAR
    t[i](IN := Change(n := count)); END_PROGRAM`,
    `FUNCTION Change : BOOL VAR_IN_OUT n : INT; END_VAR n := n + 1; Change := TRUE; END_FUNCTION`,
  ]);
  runtime.step();
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.index-out-of-range",
    pou: "Main",
    instance: "T[5]",
  });
  expect(value("count")).toMatchObject({ value: 0 });
  expect(value("t[1]")).toMatchObject({ inputs: [{ value: false }, { value: 0 }] });
});

it("names nested element fault paths and preserves persistent state until cold reset", () => {
  const { runtime, value } = setup([
    "PROGRAM Main VAR m : ARRAY[1..2] OF Outer; END_VAR m[2](); END_PROGRAM",
    "FUNCTION_BLOCK Outer VAR delay : Broken; END_VAR delay(); END_FUNCTION_BLOCK",
    "FUNCTION_BLOCK Broken VAR calls : INT; zero : INT; END_VAR calls := calls + 1; calls := calls / zero; END_FUNCTION_BLOCK",
  ]);
  runtime.step();
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.division-by-zero",
    pou: "Broken",
    instance: "M[2].DELAY",
  });
  expect(value("M[1].DELAY.CALLS")).toMatchObject({ value: 0 });
  expect(value("M[2].DELAY.CALLS")).toMatchObject({ value: 1 });
  runtime.coldReset();
  expect(value("M[2].DELAY.CALLS")).toMatchObject({ value: 0 });
});

it("runs multidimensional user and standard arrays declared inside block elements", () => {
  const { runtime, value, ir } = setup([
    "PROGRAM Main VAR m : ARRAY[1..2] OF Outer; END_VAR m[2](); END_PROGRAM",
    "FUNCTION_BLOCK Outer VAR nested : ARRAY[-1..0,1..2] OF Inner; t : ARRAY[1..2] OF TON; END_VAR nested[0,2](enable := TRUE); t[2].IN := nested[0,2].running; t[2](PT := LTIME#0ns); END_FUNCTION_BLOCK",
    "FUNCTION_BLOCK Inner VAR_INPUT enable : BOOL; END_VAR VAR_OUTPUT running : BOOL; END_VAR running := enable; END_FUNCTION_BLOCK",
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("M[2].NESTED[0,2].RUNNING")).toMatchObject({ value: true });
  expect(value("M[1].NESTED[0,2].RUNNING")).toMatchObject({ value: false });
  expect(value("M[2].T[2]")).toMatchObject({
    inputs: [{ value: true }, { dataType: "LTIME", value: "0" }],
  });
  expect(ir.composites?.find((c) => c.name === "M[2].NESTED")?.path).toEqual([
    "M",
    "[2]",
    "NESTED",
  ]);
});

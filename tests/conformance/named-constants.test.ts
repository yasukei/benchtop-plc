import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

it("executes typed constants in every POU without allocating storage or shifting bindings", () => {
  const compiled = compileProject([
    `PROGRAM Main
     VAR CONSTANT MAX_COUNT : INT := 10; N : INT := 30000; First : INT := 1;
       Last : INT := 3; Step : INT := 2; BitIndex : INT := 7; END_VAR
     VAR selected : BOOL; x : INT := MAX_COUNT; wrapped : INT := N + N;
       i, sum, functionResult, functionOutput : INT; bits : BYTE; inst : Block; END_VAR
     CASE x OF MAX_COUNT: selected := TRUE; END_CASE;
     FOR i := First TO Last BY Step DO sum := sum + i; END_FOR;
     bits.BitIndex := TRUE;
     functionResult := Compute(A := 2, Q => functionOutput, Ref := x);
     inst(A := 3, Ref := x); inst.A := inst.Q;
     END_PROGRAM`,
    `FUNCTION Compute : INT
     VAR CONSTANT N : INT := 5; END_VAR
     VAR_INPUT A : INT := N; END_VAR
     VAR CONSTANT Extra : INT := 2; END_VAR
     VAR_OUTPUT Q : INT; END_VAR
     VAR_IN_OUT Ref : INT; END_VAR
     Q := A + N; Ref := Ref + Extra; Compute := Q + Extra;
     END_FUNCTION`,
    `FUNCTION_BLOCK Block
     VAR CONSTANT N : INT := 20; END_VAR
     VAR_INPUT A : INT := N; END_VAR
     VAR CONSTANT Extra : INT := 1; END_VAR
     VAR_OUTPUT Q : INT; END_VAR
     VAR_IN_OUT Ref : INT; END_VAR
     VAR_TEMP Temp : INT := Extra; END_VAR
     VAR local : INT := N; END_VAR
     Q := A + local + Temp; Ref := Ref + Extra;
     END_FUNCTION_BLOCK`,
  ]);
  expect(compiled.diagnostics).toEqual([]);
  const ir = compiled.ir!;
  expect(ir.variables.map((variable) => variable.name)).toEqual([
    "selected",
    "x",
    "wrapped",
    "i",
    "sum",
    "functionResult",
    "functionOutput",
    "bits",
    "INST.A",
    "INST.Q",
    "INST.LOCAL",
  ]);
  expect(ir.functions![0]!.variables.map((variable) => variable.name)).toEqual([
    "A",
    "Q",
    "Ref",
    "Compute",
  ]);
  expect(ir.functionBlocks![0]!.variables.map((variable) => variable.name)).toEqual([
    "A",
    "Q",
    "Ref",
    "Temp",
    "local",
  ]);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(structuredClone(ir));
  const snapshot = runtime.scanOnce();
  expect(snapshot.scanCount).toBe(1);
  expect(
    snapshot.variables.map((variable) => (variable.kind === "scalar" ? variable.value : null)),
  ).toEqual([true, 13, -5536, 5, 4, 9, 7, 128, 24, 24, 20]);
});

import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable } from "@benchtop-plc/core";
import {
  createRuntime,
  RuntimeCommandRejected,
  VirtualClock,
  VirtualTicker,
} from "@benchtop-plc/runtime";

const configuration = (instances = "PROGRAM A WITH T : Counter; PROGRAM B WITH T : Counter;") =>
  `CONFIGURATION Plant RESOURCE Station ON Cpu TASK T (INTERVAL := T#20ms, PRIORITY := 1); ${instances} END_RESOURCE END_CONFIGURATION`;
function setup(
  pous = ["PROGRAM Counter VAR n : INT; END_VAR n := n + 1; END_PROGRAM"],
  source = configuration(),
) {
  const result = compileProject(pous, [], source);
  expect(result.diagnostics).toEqual([]);
  const ir = structuredClone(result.ir!);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  const id = (path: string) =>
    ir.variables.findIndex((variable) => variable.key === path.toUpperCase());
  const value = (path: string) => snapshotVariable(runtime.snapshot(), id(path));
  return { ir, runtime, clock, id, value };
}

it("uses the configured interval, runs every instance on step, and rejects setCycle", () => {
  const { runtime, clock, value } = setup();
  runtime.run();
  clock.advance(19);
  expect(runtime.snapshot().scanCount).toBe(0);
  clock.advance(1);
  expect(value("A.n")).toMatchObject({ value: 1 });
  expect(value("B.n")).toMatchObject({ value: 1 });
  expect(() => runtime.setCycle(10)).toThrow(RuntimeCommandRejected);
  expect(runtime.state).toBe("RUN");
  clock.advance(20);
  expect(value("B.n")).toMatchObject({ value: 2 });
  runtime.stop();
  runtime.step();
  expect(value("A.n")).toMatchObject({ value: 3 });
  runtime.coldReset();
  expect(value("A.n")).toMatchObject({ value: 0 });
  expect(value("B.n")).toMatchObject({ value: 0 });
});

it("targets writes and forces by the instance's unique leaf ID and annotates only the first instance", () => {
  const { runtime, id, value } = setup();
  runtime.write(id("A.n"), { dataType: "INT", value: 8 });
  runtime.force(id("B.n"), { dataType: "INT", value: 42 });
  const snapshot = runtime.step();
  expect(value("A.n")).toMatchObject({ value: 9 });
  expect(value("B.n")).toMatchObject({ value: 42 });
  expect(
    Object.values(snapshot.annotations.Counter!)
      .flat()
      .flatMap((entry) => entry.values),
  ).toEqual([{ dataType: "INT", value: 9 }]);
  snapshot.annotations.Counter![1]![0]!.values.length = 0;
  expect(Object.values(runtime.snapshot().annotations.Counter!).flat()[0]!.values).toHaveLength(1);
});

it("shares the task loop budget and stops later instances after a fault", () => {
  const { runtime, value } = setup(
    [
      "PROGRAM Counter VAR n : DINT; END_VAR FOR n := 1 TO 100001 DO END_FOR; END_PROGRAM",
      "PROGRAM Later VAR reached : BOOL; END_VAR reached := TRUE; END_PROGRAM",
    ],
    configuration(
      "PROGRAM A WITH T : Counter; PROGRAM B WITH T : Counter; PROGRAM C WITH T : Later;",
    ),
  );
  runtime.step();
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.watchdog",
    task: "T",
    pou: "Counter",
    instance: "B",
  });
  expect(value("C.reached")).toMatchObject({ value: false });
});

it("keeps PROGRAM annotations separate when two bodies execute on the same line", () => {
  const { runtime } = setup(
    [
      "PROGRAM Counter VAR n : INT; END_VAR n := 1; END_PROGRAM",
      "PROGRAM Other VAR n : INT; END_VAR n := 2; END_PROGRAM",
    ],
    configuration("PROGRAM A WITH T : Counter; PROGRAM B WITH T : Other;"),
  );
  const annotations = runtime.step().annotations;
  expect(annotations.Counter![1]![0]!.values).toEqual([{ dataType: "INT", value: 1 }]);
  expect(annotations.Other![1]![0]!.values).toEqual([{ dataType: "INT", value: 2 }]);
});

it("isolates nested blocks, arrays, references and temporaries in repeated program instances", () => {
  const { runtime, value, ir } = setup([
    `PROGRAM Counter VAR m : Block; a : ARRAY[1..2] OF INT; r : REF_TO INT; n : INT; END_VAR
     VAR_TEMP scratch : INT := 4; END_VAR
     scratch := scratch + 1; n := scratch; a[1] := a[1] + 1; r := REF(a[1]); m(); END_PROGRAM`,
    "FUNCTION_BLOCK Block VAR_OUTPUT n : INT; END_VAR n := n + 1; END_FUNCTION_BLOCK",
  ]);
  runtime.watch(ir.variables.map((_, id) => id));
  runtime.step();
  runtime.step();
  for (const name of ["A", "B"]) {
    expect(value(`${name}.n`)).toMatchObject({ value: 5 });
    expect(value(`${name}.A[1]`)).toMatchObject({ value: 2 });
    expect(value(`${name}.M.N`)).toMatchObject({ value: 2 });
    expect(value(`${name}.r`)).toEqual({ kind: "reference", target: `${name}.A[1]` });
  }
});

it("executes in resource declaration order and checks but never runs an unused PROGRAM", () => {
  const calls: string[] = [];
  const ir = compileProject(
    [
      "PROGRAM One VAR n : INT; END_VAR n := 1; END_PROGRAM",
      "PROGRAM Two VAR n : INT; END_VAR n := 2; END_PROGRAM",
      "PROGRAM Unused VAR n, zero : INT; END_VAR n := 1 / zero; END_PROGRAM",
    ],
    [],
    configuration("PROGRAM B WITH T : Two; PROGRAM A WITH T : One;"),
  ).ir!;
  const clock = new VirtualClock();
  const runtime = createRuntime({
    clock,
    ticker: new VirtualTicker(clock),
    stages: {
      applyForces(memory) {
        calls.push(`${memory.read(0)}:${memory.read(1)}`);
      },
    },
  });
  runtime.load(ir);
  runtime.step();
  expect(runtime.state).toBe("STOP");
  expect(ir.variables.map((v) => v.name)).toEqual(["B.n", "A.n"]);
  expect(calls).toEqual(["0:0", "2:0", "2:0", "2:1"]);
});

it("preserves outputs while changing an implicit configuration's cycle", () => {
  const ir = compileProject([
    "PROGRAM P VAR lamp AT %QX0.0 : BOOL; END_VAR lamp := TRUE; END_PROGRAM",
  ]).ir!;
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  runtime.run();
  clock.advance(10);
  expect(runtime.snapshot().outputs[0]).toBe(1);
  runtime.setCycle(20);
  expect(runtime.state).toBe("RUN");
  expect(runtime.snapshot().outputs[0]).toBe(1);
  clock.advance(19);
  expect(runtime.snapshot().scanCount).toBe(1);
  clock.advance(1);
  expect(runtime.snapshot().scanCount).toBe(2);
  runtime.coldReset();
  runtime.run();
  clock.advance(19);
  expect(runtime.snapshot().scanCount).toBe(0);
  clock.advance(1);
  expect(runtime.snapshot().scanCount).toBe(1);
});

it("transports annotations for a POU whose name is also an Object prototype property", () => {
  const { runtime } = setup(
    ["PROGRAM __proto__ VAR n : INT; END_VAR n := 1; END_PROGRAM"],
    configuration("PROGRAM A WITH T : __proto__;"),
  );
  expect(Object.keys(runtime.step().annotations)).toEqual(["__proto__"]);
  expect(JSON.parse(JSON.stringify(runtime.snapshot())).annotations.__proto__[1][0].values).toEqual(
    [{ dataType: "INT", value: 1 }],
  );
});

it("restores the construction cycle when legacy IR replaces an explicit configuration", () => {
  const ir = compileProject(
    ["PROGRAM P END_PROGRAM"],
    [],
    configuration("PROGRAM A WITH T : P;"),
  ).ir!;
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock), intervalMs: 50 });
  runtime.load(ir);
  runtime.run();
  clock.advance(20);
  expect(runtime.snapshot().scanCount).toBe(1);
  runtime.load({ kind: "program", name: "Legacy", span: ir.span, variables: [], body: [] });
  runtime.run();
  clock.advance(49);
  expect(runtime.snapshot().scanCount).toBe(0);
  clock.advance(1);
  expect(runtime.snapshot().scanCount).toBe(1);
});

it("identifies the task and owning instance when a shared function faults", () => {
  const { runtime } = setup([
    "PROGRAM Counter VAR n : INT; END_VAR n := Divide(); END_PROGRAM",
    "FUNCTION Divide : INT VAR zero : INT; END_VAR Divide := 1 / zero; END_FUNCTION",
  ]);
  runtime.step();
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.division-by-zero",
    pou: "Divide",
    task: "T",
    instance: "A",
  });
});

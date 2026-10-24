import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function setup(pous: string[], types: string[] = []) {
  const result = compileProject(pous, types);
  expect(result.diagnostics).toEqual([]);
  const ir = JSON.parse(JSON.stringify(result.ir)) as NonNullable<typeof result.ir>;
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  const id = (name: string) =>
    ir.variables.findIndex((v) => v.key === `MAININSTANCE.${name.toUpperCase()}`);
  runtime.watch(ir.variables.map((_, i) => i));
  const value = (name: string) => snapshotVariable(runtime.snapshot(), id(name));
  return { runtime, ir, id, value };
}

it("traces a sum, multidimensional and nested arrays, copies and bit access", () => {
  const { runtime, value } = setup([
    `PROGRAM Main VAR
    v : ARRAY[1..5] OF INT := [1, 2, 3(0)]; copy : ARRAY[1..5] OF INT;
    m : ARRAY[0..1,0..2] OF REAL; n : ARRAY[1..2] OF ARRAY[1..3] OF INT;
    flags : ARRAY[1..2] OF WORD; i, sum, nested : INT; realValue : REAL; bitValue : BOOL;
    END_VAR
    sum := 0; FOR i := 1 TO 5 DO sum := sum + v[i]; END_FOR;
    m[1,2] := 2.5; realValue := m[1,2]; n[2][3] := sum; nested := n[2][3];
    copy := MOVE(SEL(TRUE, v, MUX(0, v, copy))); copy[1] := 9;
    flags[1].3 := TRUE; bitValue := flags[1].3;
    END_PROGRAM`,
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  for (const [name, expected] of [
    ["sum", 3],
    ["v[4]", 0],
    ["copy[1]", 9],
    ["v[1]", 1],
    ["nested", 3],
    ["realValue", 2.5],
    ["bitValue", true],
    ["flags[1]", 8],
  ] as const)
    expect(value(name)).toMatchObject({ value: expected });
});

it("faults on a dynamic index and names the block and instance", () => {
  const { runtime } = setup([
    "PROGRAM Main VAR m1 : Block; END_VAR m1(); END_PROGRAM",
    `FUNCTION_BLOCK Block VAR a : ARRAY[1..5] OF INT; i : INT := 6; END_VAR a[i] := 1; END_FUNCTION_BLOCK`,
  ]);
  runtime.step();
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.index-out-of-range",
    pou: "Block",
    instance: "mainInstance.M1",
    args: { index: "6", lower: 1, upper: 5 },
  });
});

it("sends watched and forced array leaves and supports writes and forces", () => {
  const { runtime, id, value } = setup([
    "PROGRAM Main VAR v : ARRAY[1..5] OF INT := [1,2,3(0)]; sum : INT; END_VAR sum := v[1]+v[2]; END_PROGRAM",
  ]);
  runtime.watch([]);
  expect(runtime.snapshot().variables).toHaveLength(1);
  runtime.force(id("V[2]"), { dataType: "INT", value: 10 });
  runtime.step();
  expect(value("sum")).toMatchObject({ value: 11 });
  expect(value("V[2]")).toMatchObject({ value: 10 });
  expect(value("V[1]")).toBeUndefined();
  runtime.watch([id("V[1]")]);
  runtime.write(id("V[1]"), { dataType: "INT", value: 4 });
  runtime.step();
  expect(value("sum")).toMatchObject({ value: 14 });
});

it("initializes function locals and temporaries on each invocation", () => {
  const { runtime, value } = setup([
    `PROGRAM Main VAR x,y : INT; END_VAR VAR_TEMP a : ARRAY[1..1] OF INT := [3]; END_VAR x := Fresh(); y := a[1]; a[1] := 10; END_PROGRAM`,
    `FUNCTION Fresh : INT VAR a : ARRAY[1..1] OF INT := [7]; END_VAR Fresh := a[1]; a[1] := 99; END_FUNCTION`,
  ]);
  runtime.step();
  runtime.step();
  expect(value("x")).toMatchObject({ value: 7 });
  expect(value("y")).toMatchObject({ value: 3 });
});

it("copies arrays through destination string capacities and preserves enum/subrange defaults", () => {
  const { runtime, value, id } = setup(
    [
      `PROGRAM Main VAR
    source : ARRAY[1..2] OF STRING[8] := ['abcdef', 'xyz']; target : ARRAY[1..2] OF STRING[3];
    states : ARRAY[0..1] OF State := [Running]; limits : ARRAY[1..2] OF Percent;
    bound : ARRAY[1..2] OF INT := [1,2]; i, total : INT;
    END_VAR
    target := source; total := 0;
    FOR i := bound[1] TO bound[2] DO total := total + i; END_FOR;
    END_PROGRAM`,
    ],
    ["TYPE State : (Idle, Running); END_TYPE", "TYPE Percent : INT (5..100); END_TYPE"],
  );
  runtime.step();
  expect(value("target[1]")).toMatchObject({ value: "abc" });
  expect(value("states[0]")).toMatchObject({ value: 1 });
  expect(value("states[1]")).toMatchObject({ value: 0 });
  expect(value("limits[2]")).toMatchObject({ value: 5 });
  expect(value("total")).toMatchObject({ value: 3 });
  expect(() => runtime.force(id("limits[1]"), { dataType: "INT", value: 101 })).toThrow();
  expect(() => runtime.write(id("target[1]"), { dataType: "STRING", value: "long" })).toThrow();
  runtime.coldReset();
  expect(value("target[1]")).toMatchObject({ value: "" });
});

it("checks a dynamic subrange element store and exact 64-bit indices", () => {
  const { runtime } = setup([
    `PROGRAM Main VAR a : ARRAY[1..2] OF INT (0..10); n : INT := 11; END_VAR a[1] := n; END_PROGRAM`,
  ]);
  runtime.step();
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.subrange-violation",
    args: { value: 11, lower: 0, upper: 10 },
  });
  const other = setup([
    `PROGRAM Main VAR a : ARRAY[1..2] OF INT; n : ULINT := ULINT#18446744073709551615; x : INT; END_VAR x := a[n]; END_PROGRAM`,
  ]);
  other.runtime.step();
  expect(other.runtime.diagnostic).toMatchObject({
    code: "runtime.index-out-of-range",
    pou: "Main",
    args: { index: "18446744073709551615", lower: 1, upper: 2 },
  });
});

it("keeps instance arrays separate and resets block temporaries on each call", () => {
  const { runtime, value } = setup([
    "PROGRAM Main VAR m1,m2 : Block; END_VAR m1(); m1(); m2(); END_PROGRAM",
    "FUNCTION_BLOCK Block VAR a : ARRAY[1..1] OF INT := [5]; END_VAR VAR_TEMP t : ARRAY[1..1] OF INT := [2]; END_VAR a[1] := a[1] + t[1]; t[1] := 99; END_FUNCTION_BLOCK",
  ]);
  runtime.step();
  expect(value("M1.A[1]")).toMatchObject({ value: 9 });
  expect(value("M2.A[1]")).toMatchObject({ value: 7 });
  runtime.run();
  runtime.stop();
  runtime.step();
  expect(value("M1.A[1]")).toMatchObject({ value: 13 });
  runtime.coldReset();
  expect(value("M1.A[1]")).toMatchObject({ value: 5 });
});

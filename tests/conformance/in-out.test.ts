import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import type { RuntimeSnapshot } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function setup(sources: string[]) {
  const compiled = compileProject(sources);
  expect(compiled.diagnostics).toEqual([]);
  const ir = structuredClone(compiled.ir!);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  const id = (name: string) =>
    ir.variables.findIndex((variable) => variable.key === `MAININSTANCE.${name.toUpperCase()}`);
  const value = (snapshot: RuntimeSnapshot, name: string) => snapshot.variables[id(name)];
  const scalar = (snapshot: RuntimeSnapshot, name: string) => {
    const cell = value(snapshot, name);
    if (cell?.kind !== "scalar") throw new Error(`Expected scalar ${name}`);
    return cell.value;
  };
  return { ir, clock, runtime, id, value, scalar };
}

const increment = `FUNCTION Inc : INT VAR_IN_OUT n : INT; END_VAR n := n + 1; Inc := n; END_FUNCTION`;

it("traces a Swap function exchanging the caller's variables", () => {
  const { runtime, scalar } = setup([
    `PROGRAM Main VAR x : INT := 3; y : INT := 7; END_VAR Swap(A := x, B := y); END_PROGRAM`,
    `FUNCTION Swap VAR_IN_OUT A,B : INT; END_VAR VAR temp : INT; END_VAR
     temp := A; A := B; B := temp; END_FUNCTION`,
  ]);
  expect(
    [1, 2, 3].map(() => {
      const snapshot = runtime.scanOnce();
      return [scalar(snapshot, "x"), scalar(snapshot, "y")];
    }),
  ).toEqual([
    [7, 3],
    [3, 7],
    [7, 3],
  ]);
});

it("traces a block incrementing its actual and rebinding between calls without extra IDs", () => {
  const { runtime, scalar, ir } = setup([
    `PROGRAM Main VAR inst : B; x : INT := 1; y : INT := 10; END_VAR
     inst(n := x); inst(n := y); END_PROGRAM`,
    `FUNCTION_BLOCK B VAR_IN_OUT n : INT; END_VAR n := n + 1; END_FUNCTION_BLOCK`,
  ]);
  expect(ir.variables.map((variable) => variable.key)).toEqual([
    "MAININSTANCE.X",
    "MAININSTANCE.Y",
  ]);
  expect(
    [1, 2, 3].map(() => {
      const snapshot = runtime.scanOnce();
      return [scalar(snapshot, "x"), scalar(snapshot, "y")];
    }),
  ).toEqual([
    [2, 11],
    [3, 12],
    [4, 13],
  ]);
  runtime.coldReset();
  expect(scalar(runtime.scanOnce(), "x")).toBe(2);
});

it.each(["FUNCTION", "FUNCTION_BLOCK"])("shares one actual between two in-outs in a %s", (kind) => {
  const { runtime, scalar } = setup([
    `PROGRAM Main VAR x : INT := 1; ${kind === "FUNCTION_BLOCK" ? "inst : AliasPair;" : ""} END_VAR
     ${kind === "FUNCTION_BLOCK" ? "inst" : "AliasPair"}(a := x, b := x); END_PROGRAM`,
    `${kind} AliasPair VAR_IN_OUT a,b : INT; END_VAR a := a + 1; b := a + b; END_${kind}`,
  ]);
  expect([1, 2, 3].map(() => scalar(runtime.scanOnce(), "x"))).toEqual([4, 10, 22]);
});

it("copies an input before writing its aliased actual and evaluates operands/inputs left to right", () => {
  const { runtime, scalar } = setup([
    `PROGRAM Main VAR x : INT := 1; y,seen : INT; inst : B; END_VAR
     Capture(n := x, copy := x, q => seen);
     y := Inc(n := x) + x;
     inst(n := x, copy := Inc(n := x));
     END_PROGRAM`,
    increment,
    `FUNCTION Capture VAR_IN_OUT n : INT; END_VAR VAR_INPUT copy : INT; END_VAR
     VAR_OUTPUT q : INT; END_VAR n := n + 1; q := copy; END_FUNCTION`,
    `FUNCTION_BLOCK B VAR_IN_OUT n : INT; END_VAR VAR_INPUT copy : INT; END_VAR
     n := n + copy; END_FUNCTION_BLOCK`,
  ]);
  const snapshot = runtime.scanOnce();
  expect([scalar(snapshot, "seen"), scalar(snapshot, "y"), scalar(snapshot, "x")]).toEqual([
    1, 6, 8,
  ]);
});

it("passes caller inputs, outputs, aliases, locals and temporaries on to nested calls", () => {
  const { runtime, scalar } = setup([
    `PROGRAM Main VAR x : INT; inst : Outer; seen : INT; END_VAR
     VAR_TEMP temp : INT := 10; END_VAR
     inst(n := x, q => seen); Inc(n := temp); seen := seen + temp; END_PROGRAM`,
    increment,
    `FUNCTION Forward VAR_IN_OUT n : INT; END_VAR Inc(n := n); END_FUNCTION`,
    `FUNCTION_BLOCK Outer VAR_IN_OUT n : INT; END_VAR VAR_INPUT input : INT := 1; END_VAR
     VAR_OUTPUT q : INT; END_VAR VAR nested : Inner; local : INT; END_VAR
     VAR_TEMP temp : INT := 3; END_VAR
     Forward(n := input); Inc(n := q); Inc(n := local); Inc(n := temp);
     nested(n := n); q := q + input + local + temp; END_FUNCTION_BLOCK`,
    `FUNCTION_BLOCK Inner VAR_IN_OUT n : INT; END_VAR Forward(n := n); END_FUNCTION_BLOCK`,
  ]);
  expect(
    [1, 2].map(() => {
      const snapshot = runtime.scanOnce();
      return [scalar(snapshot, "x"), scalar(snapshot, "seen")];
    }),
  ).toEqual([
    [1, 19],
    [2, 29],
  ]);
});

it("rebinds a block to fresh PROGRAM temporaries on every scan", () => {
  const { runtime, scalar } = setup([
    `PROGRAM Main VAR inst : B; seen : INT; END_VAR VAR_TEMP n : INT := 5; END_VAR
     inst(n := n); seen := n; END_PROGRAM`,
    `FUNCTION_BLOCK B VAR_IN_OUT n : INT; END_VAR Inc(n := n); END_FUNCTION_BLOCK`,
    increment,
  ]);
  expect([1, 2, 3].map(() => scalar(runtime.scanOnce(), "seen"))).toEqual([6, 6, 6]);
});

it("keeps force stages on the actual: immediate seen=11, snapshot x=10", () => {
  const { runtime, scalar, id } = setup([
    `PROGRAM Main VAR x,seen : INT; END_VAR Inc(n := x); seen := x; END_PROGRAM`,
    increment,
  ]);
  runtime.force(id("x"), { dataType: "INT", value: 10 });
  const snapshot = runtime.scanOnce();
  expect([scalar(snapshot, "seen"), scalar(snapshot, "x")]).toEqual([11, 10]);
  expect(snapshot.forced).toContain(id("x"));
  runtime.force(id("x"), null);
  expect(scalar(runtime.scanOnce(), "x")).toBe(11);
});

it("aliases exact long scalar cells and keeps snapshots JSON serializable", () => {
  const { runtime, scalar } = setup([
    `PROGRAM Main VAR x : LINT := LINT#9007199254740993; inst : B; END_VAR inst(n := x); END_PROGRAM`,
    `FUNCTION_BLOCK B VAR_IN_OUT n : LINT; END_VAR F(n := n); END_FUNCTION_BLOCK`,
    `FUNCTION F VAR_IN_OUT n : LINT; END_VAR n := n + 1; END_FUNCTION`,
  ]);
  const snapshot = runtime.scanOnce();
  expect(scalar(snapshot, "x")).toBe("9007199254740994");
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
});

it("passes a function's own inputs, outputs, locals and result as actuals", () => {
  const { runtime, scalar } = setup([
    `PROGRAM Main VAR result,output : INT; END_VAR result := Forward(input := 3, q => output); END_PROGRAM`,
    increment,
    `FUNCTION Forward : INT VAR_INPUT input : INT; END_VAR VAR_OUTPUT q : INT := 1; END_VAR
     VAR local : INT := 10; END_VAR
     Inc(n := input); Inc(n := q); Inc(n := local); Inc(n := Forward);
     Forward := Forward + input + q + local; END_FUNCTION`,
  ]);
  expect(
    [1, 2].map(() => {
      const snapshot = runtime.scanOnce();
      return [scalar(snapshot, "result"), scalar(snapshot, "output")];
    }),
  ).toEqual([
    [18, 2],
    [18, 2],
  ]);
});

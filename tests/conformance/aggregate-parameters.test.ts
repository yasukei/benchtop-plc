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
  runtime.watch(ir.variables.map((_, i) => i));
  const id = (name: string) =>
    ir.variables.findIndex((v) => v.key === `MAININSTANCE.${name.toUpperCase()}`);
  const value = (name: string) => {
    const cell = snapshotVariable(runtime.snapshot(), id(name));
    if (cell?.kind !== "scalar") throw new Error(`Missing scalar ${name}`);
    return cell.value;
  };
  const step = () => {
    runtime.step();
    expect(runtime.diagnostic).toBeNull();
  };
  return { runtime, ir, id, value, step };
}
const point = "TYPE Point : STRUCT x : REAL; y : REAL := 1.0; END_STRUCT; END_TYPE";
const sum = `FUNCTION Sum : DINT VAR_IN_OUT a : ARRAY[*] OF INT; END_VAR VAR i : DINT; END_VAR
FOR i := LOWER_BOUND(a, 1) TO UPPER_BOUND(a, 1) DO Sum := Sum + a[i]; END_FOR;
END_FUNCTION`;

it("traces Sum across arrays with different bounds and forwards open aliases", () => {
  const { step, value } = setup([
    `PROGRAM Main VAR a : ARRAY[1..3] OF INT := [1,2,3]; b : ARRAY[0..2] OF INT := [4,5,6]; x,y : DINT; END_VAR
    x := Sum(a := a); y := Forward(a := b); END_PROGRAM`,
    sum,
    "FUNCTION Forward : DINT VAR_IN_OUT a : ARRAY[*] OF INT; END_VAR Forward := Sum(a := a); END_FUNCTION",
  ]);
  const trace = [1, 2, 3].map(() => {
    step();
    return [value("x"), value("y")];
  });
  expect(trace).toEqual([
    [6, 15],
    [6, 15],
    [6, 15],
  ]);
});

it("returns independent structures and arrays, including default results and nested calls", () => {
  const { step, value } = setup(
    [
      `PROGRAM Main VAR p,q : Point; a,b : ARRAY[1..2] OF Point; END_VAR
     p := MakePoint(x := 1.0, y := 2.0); q := DefaultPoint(); a := MakeArray(p := p); b := Identity(MakeArray(p := p));
     p.x := 99.0; a[1].y := 88.0; END_PROGRAM`,
      "FUNCTION MakePoint : Point VAR_INPUT x,y : REAL; END_VAR MakePoint.x := x; MakePoint.y := y; END_FUNCTION",
      "FUNCTION DefaultPoint : Point END_FUNCTION",
      "FUNCTION MakeArray : ARRAY[1..2] OF Point VAR_INPUT p : Point; END_VAR MakeArray[1] := p; MakeArray[2] := p; END_FUNCTION",
      "FUNCTION Identity : ARRAY[1..2] OF Point VAR_INPUT a : ARRAY[1..2] OF Point; END_VAR Identity := a; END_FUNCTION",
    ],
    [point],
  );
  for (let i = 0; i < 2; i++) {
    step();
    expect([
      value("p.x"),
      value("p.y"),
      value("q.x"),
      value("q.y"),
      value("a[1].x"),
      value("a[2].y"),
      value("b[1].y"),
    ]).toEqual([99, 2, 0, 1, 1, 2, 2]);
  }
});

it("copies function and block inputs and outputs, keeps FB inputs, and resets function outputs", () => {
  const { step, value } = setup([
    `PROGRAM Main VAR a : ARRAY[1..2] OF INT := [1,2]; b,c,d,e : ARRAY[1..2] OF INT; inst,other : Copier; END_VAR
     F(a := a, q => e); inst(a := a, q => b); a[1] := 9; inst(q => c); other(q => d); END_PROGRAM`,
    `FUNCTION F VAR_INPUT a : ARRAY[1..2] OF INT; END_VAR VAR_OUTPUT q : ARRAY[1..2] OF INT; END_VAR
     q := a; a[1] := 99; END_FUNCTION`,
    `FUNCTION_BLOCK Copier VAR_INPUT a : ARRAY[1..2] OF INT; END_VAR VAR_OUTPUT q : ARRAY[1..2] OF INT; END_VAR
     q := a; a[1] := a[1] + 1; END_FUNCTION_BLOCK`,
  ]);
  step();
  expect([value("a[1]"), value("b[1]"), value("c[1]"), value("d[1]"), value("e[1]")]).toEqual([
    9, 1, 2, 0, 1,
  ]);
  step();
  expect([value("b[1]"), value("c[1]"), value("d[1]"), value("e[1]")]).toEqual([9, 10, 1, 9]);
});

it("aliases multidimensional arrays, nested arrays, members and elements without extra IDs", () => {
  const { step, value, ir } = setup(
    [
      `PROGRAM Main VAR m : ARRAY[-1..0,3..4] OF INT; nested : ARRAY[1..2] OF ARRAY[5..6] OF INT; p : Point; inst : B; END_VAR
     inst(a := m); Inc(n := m[-1,3]); Fill(a := nested[2]); SetPoint(p := p); RealInc(n := p.x); END_PROGRAM`,
      "FUNCTION_BLOCK B VAR_IN_OUT a : ARRAY[*,*] OF INT; END_VAR a[LOWER_BOUND(a,1), UPPER_BOUND(a,2)] := 7; END_FUNCTION_BLOCK",
      "FUNCTION Inc VAR_IN_OUT n : INT; END_VAR n := n + 1; END_FUNCTION",
      "FUNCTION Fill VAR_IN_OUT a : ARRAY[*] OF INT; END_VAR a[LOWER_BOUND(a,1)] := 8; END_FUNCTION",
      "FUNCTION SetPoint VAR_IN_OUT p : Point; END_VAR p.y := 9.0; END_FUNCTION",
      "FUNCTION RealInc VAR_IN_OUT n : REAL; END_VAR n := n + 1.0; END_FUNCTION",
    ],
    [point],
  );
  expect(ir.variables.map((v) => v.key)).not.toContain("INST.A");
  step();
  expect([
    value("m[-1,4]"),
    value("m[-1,3]"),
    value("nested[2][5]"),
    value("p.x"),
    value("p.y"),
  ]).toEqual([7, 1, 8, 1, 9]);
});

it.each(["FUNCTION", "FUNCTION_BLOCK"])(
  "evaluates alias indices once in argument order in a %s",
  (kind) => {
    const callee = kind === "FUNCTION" ? "F" : "inst";
    const { step, value } = setup([
      `PROGRAM Main VAR a : ARRAY[1..3] OF INT := [10,20,30]; i : INT := 0; seen : INT; ${kind === "FUNCTION_BLOCK" ? "inst : F;" : ""} END_VAR
     ${callee}(io := a[Next(n := i)], input := Next(n := i), q => seen); END_PROGRAM`,
      "FUNCTION Next : INT VAR_IN_OUT n : INT; END_VAR n := n + 1; Next := n; END_FUNCTION",
      `${kind} F VAR_IN_OUT io : INT; END_VAR VAR_INPUT input : INT; END_VAR VAR_OUTPUT q : INT; END_VAR io := io + input; q := io; END_${kind}`,
    ]);
    step();
    expect([value("a[1]"), value("a[2]"), value("i"), value("seen")]).toEqual([12, 20, 2, 12]);
  },
);

it("stores strings using the actual capacity through whole and element aliases", () => {
  const { step, value } = setup([
    `PROGRAM Main VAR a : ARRAY[1..3] OF STRING[10]; END_VAR Fixed(a := a); Open(a := a); Leaf(s := a[3]); END_PROGRAM`,
    "FUNCTION Fixed VAR_IN_OUT a : ARRAY[1..3] OF STRING[20]; END_VAR VAR s : STRING[20] := 'abcdefghijklmnop'; END_VAR a[1] := s; END_FUNCTION",
    "FUNCTION Open VAR_IN_OUT a : ARRAY[*] OF STRING[20]; END_VAR VAR s : STRING[20] := 'qrstuvwxyzabcdef'; END_VAR a[2] := s; END_FUNCTION",
    "FUNCTION Leaf VAR_IN_OUT s : STRING[20]; END_VAR VAR textValue : STRING[20] := '0123456789abcdef'; END_VAR s := textValue; END_FUNCTION",
  ]);
  step();
  expect([value("a[1]"), value("a[2]"), value("a[3]")]).toEqual([
    "abcdefghij",
    "qrstuvwxyz",
    "0123456789",
  ]);
});

it("keeps forced elements visible through aliases until the end-of-scan force stage", () => {
  const { runtime, step, value, id } = setup([
    "PROGRAM Main VAR a : ARRAY[1..2] OF INT; seen : INT; END_VAR F(a := a, seen => seen); END_PROGRAM",
    "FUNCTION F VAR_IN_OUT a : ARRAY[*] OF INT; END_VAR VAR_OUTPUT seen : INT; END_VAR a[1] := a[1] + 1; seen := a[1]; END_FUNCTION",
  ]);
  runtime.force(id("a[1]"), { dataType: "INT", value: 10 });
  step();
  expect([value("a[1]"), value("seen")]).toEqual([10, 11]);
});

it("faults on indices outside the actual open-array bounds", () => {
  const { runtime } = setup([
    "PROGRAM Main VAR a : ARRAY[-2..0] OF INT; END_VAR F(a := a); END_PROGRAM",
    "FUNCTION F VAR_IN_OUT a : ARRAY[*] OF INT; END_VAR a[1] := 5; END_FUNCTION",
  ]);
  runtime.step();
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.index-out-of-range",
    pou: "F",
    args: { index: "1", lower: -2, upper: 0 },
  });
});

it("queries fixed arrays, public aggregate ports and array results without losing side effects", () => {
  const { step, value } = setup(
    [
      `PROGRAM Main VAR inst : Ports; a : ARRAY[-2..0] OF INT; n : INT; lower,upper : DINT; p : Point; END_VAR
     inst.a := a; inst.p := p; inst.a[-2] := 4; inst.p.x := 3.0;
     lower := LOWER_BOUND(DIM := 1, IN := inst.a); upper := UPPER_BOUND(ResultArray(n := n), 1);
     LOWER_BOUND(IN := a, DIM := 1); p := inst.p; a := inst.a; END_PROGRAM`,
      "FUNCTION_BLOCK Ports VAR_INPUT a : ARRAY[-2..0] OF INT; p : Point; END_VAR END_FUNCTION_BLOCK",
      "FUNCTION ResultArray : ARRAY[3..5] OF INT VAR_IN_OUT n : INT; END_VAR n := n + 1; END_FUNCTION",
    ],
    [point],
  );
  step();
  expect([value("lower"), value("upper"), value("n"), value("a[-2]"), value("p.x")]).toEqual([
    -2, 5, 1, 4, 3,
  ]);
});

it.each([
  ["1..3", "1..2", "[1,2,3]", "[9,8]"],
  ["1..2", "1..3", "[1,2]", "[9,8,7]"],
  ["1..3", "0..2", "[1,2,3]", "[9,8,7]"],
])(
  "rejects whole open-array copies with actual bounds %s and %s before writing",
  (left, right, initialLeft, initialRight) => {
    const { runtime, value } = setup([
      `PROGRAM Main VAR a : ARRAY[${left}] OF INT := ${initialLeft}; b : ARRAY[${right}] OF INT := ${initialRight}; END_VAR Copy(a := a, b := b); END_PROGRAM`,
      "FUNCTION Copy VAR_IN_OUT a,b : ARRAY[*] OF INT; END_VAR a := MOVE(SEL(FALSE, b, b)); END_FUNCTION",
    ]);
    runtime.step();
    expect(runtime.diagnostic).toMatchObject({ code: "runtime.invalid-value", pou: "Copy" });
    expect(value("a[1]")).toBe(1);
    expect(value("a[2]")).toBe(2);
  },
);

it("copies whole compatible open arrays and applies destination string capacities", () => {
  const { step, value } = setup([
    "PROGRAM Main VAR a : ARRAY[1..2] OF STRING[3]; b : ARRAY[1..2] OF STRING[10] := ['abcdef','ghijkl']; END_VAR Copy(a := a, b := b); END_PROGRAM",
    "FUNCTION Copy VAR_IN_OUT a,b : ARRAY[*] OF STRING[20]; END_VAR a := b; END_FUNCTION",
  ]);
  step();
  expect([value("a[1]"), value("a[2]"), value("b[1]")]).toEqual(["abc", "ghi", "abcdef"]);
});

it("queries concrete bounds through MOVE, SEL and MUX of open-array aliases", () => {
  const { step, value } = setup([
    "PROGRAM Main VAR a : ARRAY[-2..0] OF INT; b : ARRAY[3..6] OF INT; lower,upper : DINT; END_VAR Bounds(a := a, b := b, lower => lower, upper => upper); END_PROGRAM",
    `FUNCTION Bounds VAR_IN_OUT a,b : ARRAY[*] OF INT; END_VAR VAR_OUTPUT lower,upper : DINT; END_VAR
     lower := LOWER_BOUND(MOVE(SEL(TRUE, b, a)), 1);
     upper := UPPER_BOUND(MUX(1, a, b), 1); END_FUNCTION`,
  ]);
  step();
  expect([value("lower"), value("upper")]).toEqual([-2, 6]);
});

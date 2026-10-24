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

const point = "TYPE Point : STRUCT x : REAL; y : REAL := 1.0; END_STRUCT; END_TYPE";

it("traces defaults, independent whole-structure copies and structure selections", () => {
  const { runtime, value } = setup(
    [
      `PROGRAM Main VAR p,q,r : Point; c : BOOL; END_VAR
     q := p; p.x := 3.0; r := SEL(c, p, q);
     END_PROGRAM`,
    ],
    [point],
  );
  expect(value("p.x")).toMatchObject({ value: 0 });
  expect(value("p.y")).toMatchObject({ value: 1 });
  expect(value("q.y")).toMatchObject({ value: 1 });
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("q.x")).toMatchObject({ value: 0 });
  expect(value("q.y")).toMatchObject({ value: 1 });
  expect(value("p.x")).toMatchObject({ value: 3 });
  expect(value("r.x")).toMatchObject({ value: 3 });
  runtime.step();
  expect(value("q.x")).toMatchObject({ value: 3 });
});

it("traces a FOR loop over structures and arbitrary alternating array/member chains", () => {
  const { runtime, value } = setup(
    [
      `PROGRAM Main VAR
     pts : ARRAY[1..3] OF Point := [(x := 1.0), (x := 2.0), (x := 3.0)];
     line : ARRAY[1..2] OF LineType; sum : REAL; i : INT; r : Point;
     END_VAR
     sum := 0.0; FOR i := 1 TO 3 DO sum := sum + pts[i].x; END_FOR;
     line[2].start.x := sum;
     line[2].steps[1].x := line[2].start.x;
     r := MOVE(MUX(1, pts[1], SEL(TRUE, pts[2], line[2].steps[1])));
     line[1].steps := pts;
     line[1].steps[2].x := 9.0;
     END_PROGRAM`,
    ],
    [
      "TYPE LineType : STRUCT start : Point; steps : ARRAY[1..3] OF Point; END_STRUCT; END_TYPE",
      point,
    ],
  );
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  for (const [name, expected] of [
    ["sum", 6],
    ["line[2].start.x", 6],
    ["line[2].steps[1].x", 6],
    ["r.x", 6],
    ["r.y", 1],
    ["line[1].steps[2].x", 9],
    ["pts[2].x", 2],
  ] as const)
    expect(value(name)).toMatchObject({ value: expected });
});

it("preserves nested defaults, enum/subrange/64-bit/text leaves, writes and forces", () => {
  const types = [
    "TYPE State : (Idle, Running); END_TYPE",
    "TYPE Percentage : INT (5..10); END_TYPE",
    "TYPE RecordType : STRUCT stateValue : State := Running; n : Percentage; textValue : STRING[3] := 'abc'; bits : WORD; big : ULINT := ULINT#18446744073709551615; END_STRUCT; END_TYPE",
    "TYPE Container : STRUCT records : ARRAY[1..2] OF RecordType := [(n := 7)]; END_STRUCT; END_TYPE",
  ];
  const { runtime, value, id } = setup(
    [
      `PROGRAM Main VAR a,b : Container; sum : INT; bitValue : BOOL; END_VAR
     b := MOVE(a); a.records[2].bits.3 := TRUE;
     bitValue := a.records[2].bits.3;
     sum := a.records[1].n + a.records[2].n;
     END_PROGRAM`,
    ],
    types,
  );
  expect(value("a.records[1].n")).toMatchObject({ value: 7 });
  expect(value("a.records[2].n")).toMatchObject({ value: 5 });
  runtime.force(id("a.records[2].n"), { dataType: "INT", value: 10 });
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("sum")).toMatchObject({ value: 17 });
  expect(value("b.records[2].n")).toMatchObject({ value: 10 });
  expect(value("bitValue")).toMatchObject({ value: true });
  expect(value("b.records[1].big")).toMatchObject({ value: "18446744073709551615" });
  expect(value("b.records[2].stateValue")).toMatchObject({ value: 1 });
  expect(() => runtime.write(id("a.records[1].n"), { dataType: "INT", value: 11 })).toThrow();
  expect(() =>
    runtime.force(id("a.records[1].textValue"), { dataType: "STRING", value: "long" }),
  ).toThrow();
  runtime.write(id("a.records[1].textValue"), { dataType: "STRING", value: "new" });
  runtime.step();
  expect(value("b.records[1].textValue")).toMatchObject({ value: "new" });
  runtime.coldReset();
  expect(value("a.records[1].textValue")).toMatchObject({ value: "abc" });
});

it("initializes function locals and temporaries on every invocation and separates instances", () => {
  const { runtime, value } = setup(
    [
      `PROGRAM Main VAR a,b : Block; x,y : REAL; END_VAR VAR_TEMP p : Point; END_VAR
     a(); a(); b(); x := Fresh(); y := p.y; p.y := 99.0; END_PROGRAM`,
      "FUNCTION Fresh : REAL VAR p : Point; END_VAR Fresh := p.y; p.y := 99.0; END_FUNCTION",
      "FUNCTION_BLOCK Block VAR p : Point; END_VAR VAR_TEMP t : Point; END_VAR p.x := p.x + t.y; t.y := 99.0; END_FUNCTION_BLOCK",
    ],
    [point],
  );
  for (let scan = 1; scan <= 2; scan++) {
    runtime.step();
    expect(runtime.diagnostic).toBeNull();
    expect(value("a.p.x")).toMatchObject({ value: 2 * scan });
    expect(value("b.p.x")).toMatchObject({ value: scan });
    expect(value("x")).toMatchObject({ value: 1 });
    expect(value("y")).toMatchObject({ value: 1 });
  }
});

it("faults on nested dynamic indices and member subrange stores", () => {
  const { runtime } = setup(
    ["PROGRAM Main VAR p : Container; i : INT := 3; END_VAR p.points[i].x := 1.0; END_PROGRAM"],
    [point, "TYPE Container : STRUCT points : ARRAY[1..2] OF Point; END_STRUCT; END_TYPE"],
  );
  runtime.step();
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.index-out-of-range",
    args: { index: "3", lower: 1, upper: 2 },
  });
  const other = setup(
    ["PROGRAM Main VAR p : Limited; n : INT := 11; END_VAR p.n := n; END_PROGRAM"],
    ["TYPE Limited : STRUCT n : INT (0..10); END_STRUCT; END_TYPE"],
  );
  other.runtime.step();
  expect(other.runtime.diagnostic).toMatchObject({
    code: "runtime.subrange-violation",
    args: { value: 11, lower: 0, upper: 10 },
  });
});

import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

const point = "TYPE Point : STRUCT x : REAL; END_STRUCT; END_TYPE";
function setup(pous: string[], types: string[] = []) {
  const result = compileProject(pous, types);
  expect(result.diagnostics).toEqual([]);
  const ir = JSON.parse(JSON.stringify(result.ir)) as NonNullable<typeof result.ir>;
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  const id = (name: string) => ir.variables.findIndex((v) => v.key === name.toUpperCase());
  runtime.watch(ir.variables.map((_, i) => i));
  const value = (name: string) => snapshotVariable(runtime.snapshot(), id(name));
  return { runtime, ir, id, value };
}

it("traces retargeting between structures, identity comparisons and cold reset", () => {
  const { runtime, value, ir, id } = setup(
    [
      `PROGRAM Main VAR
    p1,p2 : Point; r,s : REF_TO Point; second : BOOL; equal,empty : BOOL;
    END_VAR
    IF second THEN r := REF(p2); ELSE r := REF(p1); END_IF;
    r^.x := r^.x + 5.0;
    s := r; equal := s = r; empty := NULL = r; second := TRUE;
    END_PROGRAM`,
    ],
    [point],
  );
  expect(value("r")).toEqual({ kind: "reference", target: null });
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("r")).toEqual({ kind: "reference", target: "P1" });
  expect(value("p1.x")).toMatchObject({ value: 5 });
  expect(value("p2.x")).toMatchObject({ value: 0 });
  expect(value("equal")).toMatchObject({ value: true });
  expect(value("empty")).toMatchObject({ value: false });
  runtime.step();
  expect(value("r")).toEqual({ kind: "reference", target: "P2" });
  expect(value("p1.x")).toMatchObject({ value: 5 });
  expect(value("p2.x")).toMatchObject({ value: 5 });
  const assignment = ir.body[0]!;
  expect(assignment.kind).toBe("if");
  expect(
    Object.values(runtime.snapshot().annotations).flatMap((a) => a.flatMap((v) => v.values)),
  ).toContainEqual({ kind: "reference", target: "P2" });
  expect(JSON.parse(JSON.stringify(runtime.snapshot()))).toEqual(runtime.snapshot());
  expect(() => runtime.write(id("r"), { dataType: "INT", value: 0 })).toThrow();
  expect(() => runtime.force(id("r"), { dataType: "INT", value: 0 })).toThrow();
  runtime.coldReset();
  expect(value("r")).toEqual({ kind: "reference", target: null });
});

it("traces arrays, structure reference members, nested references and aggregate copies", () => {
  const { runtime, value } = setup(
    [
      `PROGRAM Main VAR
    points : ARRAY[1..2] OF Point; refs : ARRAY[1..2] OF REF_TO Point;
    a,b : Holder; ar : REF_TO ARRAY[1..2] OF Point; rr : REF_TO REF_TO Point;
    END_VAR
    ar := REF(points); refs[1] := REF(points[2]); a.link := refs[1]; b := a;
    rr := REF(a.link); rr^^.x := 7.0; ar^[1].x := b.link^.x;
    END_PROGRAM`,
    ],
    [point, "TYPE Holder : STRUCT link : REF_TO Point; END_STRUCT; END_TYPE"],
  );
  expect(value("a.link")).toEqual({ kind: "reference", target: null });
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("points[1].x")).toMatchObject({ value: 7 });
  expect(value("points[2].x")).toMatchObject({ value: 7 });
  expect(value("refs[1]")).toEqual({ kind: "reference", target: "POINTS[2]" });
  expect(value("a.link")).toEqual({ kind: "reference", target: "POINTS[2]" });
  expect(value("b.link")).toEqual({ kind: "reference", target: "POINTS[2]" });
  expect(value("ar")).toEqual({ kind: "reference", target: "POINTS" });
  expect(value("rr")).toEqual({ kind: "reference", target: "A.LINK" });
});

it("passes reference inputs, outputs, in-outs and results without copying targets", () => {
  const { runtime, value } = setup([
    `PROGRAM Main VAR x,y : INT; r,s : REF_TO INT; b : Block; END_VAR
     r := REF(x); s := Identity(r); s^ := 3;
     Change(p := r, replacement := REF(y)); r^ := 9;
     b(p := s, q => r); r^ := r^ + 1;
     END_PROGRAM`,
    "FUNCTION Identity : REF_TO INT VAR_INPUT p : REF_TO INT; END_VAR Identity := p; END_FUNCTION",
    "FUNCTION Change VAR_IN_OUT p : REF_TO INT; END_VAR VAR_INPUT replacement : REF_TO INT; END_VAR p := replacement; END_FUNCTION",
    "FUNCTION_BLOCK Block VAR_INPUT p : REF_TO INT; END_VAR VAR_OUTPUT q : REF_TO INT; END_VAR q := p; END_FUNCTION_BLOCK",
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("x")).toMatchObject({ value: 4 });
  expect(value("y")).toMatchObject({ value: 9 });
  expect(value("r")).toEqual({ kind: "reference", target: "x" });
});

it("keeps references to each block's own persistent members separate", () => {
  const { runtime, value } = setup([
    "PROGRAM Main VAR a,b : Block; r : REF_TO INT; END_VAR a(); b(); r := REF(a.q); r^ := 11; END_PROGRAM",
    "FUNCTION_BLOCK Block VAR x : INT; r : REF_TO INT; END_VAR VAR_OUTPUT q : INT; END_VAR r := REF(x); r^ := r^ + 1; q := x; END_FUNCTION_BLOCK",
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("a.r")).toEqual({ kind: "reference", target: "A.X" });
  expect(value("b.r")).toEqual({ kind: "reference", target: "B.X" });
  expect(value("a.q")).toMatchObject({ value: 11 });
  expect(value("b.q")).toMatchObject({ value: 1 });
});

it("faults on NULL with the POU and nested instance path", () => {
  const main = setup(
    ["PROGRAM Main VAR r : REF_TO Point; END_VAR r^.x := 5.0; END_PROGRAM"],
    [point],
  );
  main.runtime.step();
  expect(main.runtime.state).toBe("FAULT");
  expect(main.runtime.diagnostic).toMatchObject({ code: "runtime.null-reference", pou: "Main" });
  const nested = setup([
    "PROGRAM Main VAR b : Block; END_VAR b(); END_PROGRAM",
    "FUNCTION_BLOCK Block VAR r : REF_TO INT; END_VAR r^ := 1; END_FUNCTION_BLOCK",
  ]);
  nested.runtime.step();
  expect(nested.runtime.diagnostic).toMatchObject({
    code: "runtime.null-reference",
    pou: "Block",
    instance: "B",
  });
});

it("retains reference identity through dynamic indices and standard block port updates", () => {
  const { runtime, value } = setup([
    `PROGRAM Main VAR timers : ARRAY[1..2] OF TON; r,s : REF_TO TIME; i : INT := 1; same : BOOL; END_VAR
     r := REF(timers[i].PT); s := REF(timers[1].PT); same := r = s;
     r^ := T#2s; timers[1](IN := TRUE); i := 2;
     END_PROGRAM`,
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("r")).toEqual({ kind: "reference", target: "TIMERS[1].PT" });
  expect(value("same")).toMatchObject({ value: true });
  expect(value("timers[1]")).toMatchObject({ inputs: [{ value: true }, { value: 2000 }] });
  runtime.step();
  expect(value("r")).toEqual({ kind: "reference", target: "TIMERS[2].PT" });
  expect(value("same")).toMatchObject({ value: false });
});

it("walks recursive records and preserves target constraints and force stages", () => {
  const { runtime, value, id } = setup(
    [
      `PROGRAM Main VAR a,b : Node; r : REF_TO Node; seen : INT; END_VAR
     a.next := REF(b); r := REF(a); r^.next^.value := 7; seen := b.value;
     END_PROGRAM`,
    ],
    ["TYPE Node : STRUCT value : INT (0..10); next : REF_TO Node; END_STRUCT; END_TYPE"],
  );
  runtime.force(id("b.value"), { dataType: "INT", value: 4 });
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("a.next")).toEqual({ kind: "reference", target: "B" });
  expect(value("seen")).toMatchObject({ value: 7 });
  expect(value("b.value")).toMatchObject({ value: 4 });
  const invalid = setup([
    "PROGRAM Main VAR x : INT (0..10); r : REF_TO INT (0..10); n : INT := 11; END_VAR r := REF(x); r^ := n; END_PROGRAM",
  ]);
  invalid.runtime.step();
  expect(invalid.runtime.diagnostic).toMatchObject({
    code: "runtime.subrange-violation",
    pou: "Main",
  });
});

it("preserves aggregate reference identity across scans while resetting temporaries", () => {
  const { runtime, value } = setup(
    [
      `PROGRAM Main VAR p : Point; a : ARRAY[1..2] OF Point; r,s : REF_TO Point; started,equal : BOOL; seen : INT; END_VAR
     VAR_TEMP temp : INT; END_VAR
     IF NOT started THEN r := REF(p); s := REF(a[1]); started := TRUE; END_IF;
     equal := (r = REF(p)) AND (s = REF(a[1])); seen := temp; temp := 9;
     END_PROGRAM`,
    ],
    [point],
  );
  for (let scan = 0; scan < 3; scan++) {
    runtime.step();
    expect(runtime.diagnostic).toBeNull();
    expect(value("equal")).toMatchObject({ value: true });
    expect(value("seen")).toMatchObject({ value: 0 });
  }
});

it("traverses a named recursive array without losing exact reference matching", () => {
  const { runtime, value } = setup(
    [
      "PROGRAM Main VAR first,second : Links; r : REF_TO Links; equal : BOOL; END_VAR first[1] := REF(second); r := REF(first); r^[1]^[2] := REF(first); equal := second[2] = r; END_PROGRAM",
    ],
    ["TYPE Links : ARRAY[1..2] OF REF_TO Links; END_TYPE"],
  );
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("first[1]")).toEqual({ kind: "reference", target: "SECOND" });
  expect(value("second[2]")).toEqual({ kind: "reference", target: "FIRST" });
  expect(value("equal")).toMatchObject({ value: true });
});

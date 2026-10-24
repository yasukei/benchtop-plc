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

it("selects reference identities and NULL with MOVE, SEL and MUX", () => {
  const { runtime, value } = setup([
    `PROGRAM Main VAR x,y : INT; r,s,t : REF_TO INT; empty,same : BOOL; END_VAR
     r := MOVE(REF(x)); s := SEL(TRUE, r, REF(y));
     t := MUX(1, r, s, NULL); t^ := 7;
     same := MOVE(r) = REF(x); empty := SEL(FALSE, NULL, r) = NULL;
     r := MOVE(NULL); s := MUX(2, REF(x), REF(y), NULL);
     MOVE(t); SEL(TRUE, NULL, t); MUX(0, t, NULL);
     END_PROGRAM`,
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("x")).toMatchObject({ value: 0 });
  expect(value("y")).toMatchObject({ value: 7 });
  expect(value("t")).toEqual({ kind: "reference", target: "y" });
  expect(value("r")).toEqual({ kind: "reference", target: null });
  expect(value("s")).toEqual({ kind: "reference", target: null });
  expect(value("same")).toMatchObject({ value: true });
  expect(value("empty")).toMatchObject({ value: true });
  const annotations = Object.values(runtime.snapshot().annotations).flatMap((a) =>
    a.flatMap((v) => v.values),
  );
  expect(annotations.slice(-3)).toEqual(
    Array.from({ length: 3 }, () => ({ kind: "reference", target: "y" })),
  );
});

it("evaluates all reference selection arguments once in source order", () => {
  const { runtime, value } = setup([
    `PROGRAM Main VAR x,y : INT; r : REF_TO INT; trace : INT; END_VAR
     r := SEL(FALSE, Mark(p := REF(x), digit := 1, trace := trace), Mark(p := REF(y), digit := 2, trace := trace));
     r^ := 5;
     r := MUX(0, Mark(p := REF(x), digit := 3, trace := trace), Mark(p := REF(y), digit := 4, trace := trace));
     END_PROGRAM`,
    `FUNCTION Mark : REF_TO INT VAR_INPUT p : REF_TO INT; digit : INT; END_VAR
     VAR_IN_OUT trace : INT; END_VAR trace := trace * 10 + digit; Mark := p; END_FUNCTION`,
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("trace")).toMatchObject({ value: 1234 });
  expect(value("x")).toMatchObject({ value: 5 });
  expect(value("y")).toMatchObject({ value: 0 });
});

it.each([-1, 2])("faults for an out-of-range reference MUX selector %s", (selector) => {
  const { runtime } = setup([
    `PROGRAM Main VAR x : INT; r : REF_TO INT; END_VAR r := MUX(${selector}, REF(x), NULL); END_PROGRAM`,
  ]);
  runtime.step();
  expect(runtime.diagnostic).toMatchObject({ code: "runtime.invalid-value" });
});

it("aliases dereferenced scalar, structure and array storage in functions and blocks", () => {
  const { runtime, value } = setup(
    [
      `PROGRAM Main VAR x : INT; p : RecordType; a : ARRAY[1..2] OF INT;
     r : REF_TO INT; rp : REF_TO RecordType; ra : REF_TO ARRAY[1..2] OF INT; b : Increment; END_VAR
     r := REF(x); rp := REF(p); ra := REF(a);
     Inc(v := r^); b(v := rp^.n); Inc(v := ra^[2]);
     Update(p := rp^, a := ra^);
     END_PROGRAM`,
      "FUNCTION Inc VAR_IN_OUT v : INT; END_VAR v := v + 1; END_FUNCTION",
      "FUNCTION_BLOCK Increment VAR_IN_OUT v : INT; END_VAR v := v + 2; END_FUNCTION_BLOCK",
      "FUNCTION Update VAR_IN_OUT p : RecordType; a : ARRAY[*] OF INT; END_VAR p.n := p.n + 3; a[2] := a[2] + 4; END_FUNCTION",
    ],
    ["TYPE RecordType : STRUCT n : INT; END_STRUCT; END_TYPE"],
  );
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("x")).toMatchObject({ value: 1 });
  expect(value("p.n")).toMatchObject({ value: 5 });
  expect(value("a[2]")).toMatchObject({ value: 5 });
});

it("evaluates a dereferenced in-out location once and retains storage capacity", () => {
  const { runtime, value } = setup([
    `PROGRAM Main VAR texts : ARRAY[1..2] OF STRING[3]; r : REF_TO ARRAY[1..2] OF STRING[3]; i : INT; END_VAR
     r := REF(texts); Append(v := r^[Next(i := i)]); END_PROGRAM`,
    "FUNCTION Next : INT VAR_IN_OUT i : INT; END_VAR i := i + 1; Next := i; END_FUNCTION",
    "FUNCTION Append VAR_IN_OUT v : STRING[10]; END_VAR v := 'abcdef'; END_FUNCTION",
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("i")).toMatchObject({ value: 1 });
  expect(value("texts[1]")).toMatchObject({ value: "abc" });
  expect(value("texts[2]")).toMatchObject({ value: "" });
});

it("faults on a NULL dereferenced in-out actual before entering the callee", () => {
  const { runtime, value } = setup([
    "PROGRAM Main VAR r : REF_TO INT; called : BOOL; END_VAR Inc(v := r^, called := called); END_PROGRAM",
    "FUNCTION Inc VAR_IN_OUT v : INT; called : BOOL; END_VAR called := TRUE; v := 1; END_FUNCTION",
  ]);
  runtime.step();
  expect(runtime.diagnostic).toMatchObject({ code: "runtime.null-reference", pou: "Main" });
  expect(value("called")).toMatchObject({ value: false });
});

it("aliases referenced standard block ports through nested in-out calls", () => {
  const { runtime, value } = setup([
    `PROGRAM Main VAR t : TON; r,s : REF_TO TIME; b : SetTimeBlock; seen : TIME; END_VAR
     r := REF(t.PT); s := REF(t.ET); Forward(v := r^);
     t(IN := TRUE); b(v := s^); seen := s^;
     END_PROGRAM`,
    "FUNCTION SetTime VAR_IN_OUT v : TIME; END_VAR v := T#2s; END_FUNCTION",
    "FUNCTION Forward VAR_IN_OUT v : TIME; END_VAR SetTime(v := v); END_FUNCTION",
    "FUNCTION_BLOCK SetTimeBlock VAR_IN_OUT v : TIME; END_VAR v := T#3s; END_FUNCTION_BLOCK",
  ]);
  for (let scan = 0; scan < 2; scan++) {
    runtime.step();
    expect(runtime.diagnostic).toBeNull();
    expect(value("t")).toMatchObject({
      inputs: [{ value: true }, { value: 2000 }],
      outputs: [{ value: false }, { value: 3000 }],
    });
    expect(value("seen")).toMatchObject({ value: 3000 });
  }
});

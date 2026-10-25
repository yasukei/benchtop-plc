import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable, type ConfigurationIR } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function setup(pous: string[], configuration: string, types: string[] = []) {
  const result = compileProject(pous, types, configuration);
  expect(result.diagnostics).toEqual([]);
  const ir = JSON.parse(JSON.stringify(result.ir!)) as ConfigurationIR;
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  runtime.watch(ir.variables.map((_, id) => id));
  const id = (name: string) => ir.variables.findIndex((v) => v.key === name.toUpperCase());
  const value = (name: string) => snapshotVariable(runtime.snapshot(), id(name));
  return { ir, runtime, clock, id, value };
}
const config = (globals: string, instances: string, resourceGlobals = "") =>
  `CONFIGURATION Plant ${globals} RESOURCE Station ON Cpu ${resourceGlobals}
   TASK T (INTERVAL := T#10ms, PRIORITY := 1); ${instances} END_RESOURCE END_CONFIGURATION`;

it("traces two programs exchanging a global in instance declaration order", () => {
  const { runtime, value, ir, id } = setup(
    [
      "PROGRAM Writer VAR_EXTERNAL gCount : INT; END_VAR gCount := gCount + 1; END_PROGRAM",
      "PROGRAM Reader VAR_EXTERNAL gCount : INT; END_VAR VAR seen : INT; END_VAR seen := gCount; END_PROGRAM",
    ],
    config(
      "VAR_GLOBAL gCount : INT := 10; END_VAR",
      "PROGRAM A WITH T : Writer; PROGRAM B WITH T : Reader;",
    ),
  );
  expect(ir.variables.map((v) => v.name)).toEqual(["gCount", "B.seen"]);
  const trace = [];
  for (let scan = 0; scan < 3; scan++) {
    runtime.step();
    trace.push([value("gCount"), value("B.seen")].map((v) => (v && "value" in v ? v.value : null)));
  }
  expect(trace).toEqual([
    [11, 11],
    [12, 12],
    [13, 13],
  ]);
  runtime.write(id("gCount"), { dataType: "INT", value: 20 });
  runtime.step();
  expect(value("B.seen")).toMatchObject({ value: 21 });
  runtime.force(id("gCount"), { dataType: "INT", value: 42 });
  runtime.step();
  expect(value("gCount")).toMatchObject({ value: 42 });
  expect(value("B.seen")).toMatchObject({ value: 42 });
  runtime.force(id("gCount"), null);
  runtime.coldReset();
  expect(value("gCount")).toMatchObject({ value: 10 });
  expect(value("B.seen")).toMatchObject({ value: 0 });
});

it("traces FB externals sharing resource globals with program externals", () => {
  const { runtime, value, ir } = setup(
    [
      "PROGRAM Main VAR b : Reader; END_VAR VAR_EXTERNAL g : INT; END_VAR g := g + 1; b(); END_PROGRAM",
      "FUNCTION_BLOCK Reader VAR_EXTERNAL g : INT; END_VAR VAR_OUTPUT seen : INT; END_VAR seen := g; END_FUNCTION_BLOCK",
    ],
    config(
      "VAR_GLOBAL c : INT := 3; END_VAR",
      "PROGRAM A WITH T : Main; PROGRAM B WITH T : Main;",
      "VAR_GLOBAL g : INT := 5; END_VAR",
    ),
  );
  expect(ir.variables.map((v) => v.name)).toEqual(["c", "g", "A.B.SEEN", "B.B.SEEN"]);
  const trace = [];
  for (let scan = 0; scan < 3; scan++) {
    runtime.step();
    trace.push(
      [value("A.B.SEEN"), value("B.B.SEEN"), value("g")].map((v) =>
        v && "value" in v ? v.value : null,
      ),
    );
  }
  expect(trace).toEqual([
    [6, 7, 7],
    [8, 9, 9],
    [10, 11, 11],
  ]);
});

it("initializes global constants, derived values and located globals before programs", () => {
  const { runtime, value, clock } = setup(
    [
      `PROGRAM Main VAR_EXTERNAL points : ARRAY[1..2] OF Point; link : REF_TO INT; lamp : BOOL; END_VAR
     link := REF(points[2].X); link^ := link^ + 1; lamp := TRUE; END_PROGRAM`,
    ],
    config(
      "VAR_GLOBAL CONSTANT N : INT := 2; END_VAR VAR_GLOBAL points : ARRAY[1..N] OF Point := [(X := 3), (X := 7)]; link : REF_TO INT; END_VAR",
      "PROGRAM A WITH T : Main;",
      "VAR_GLOBAL lamp AT %QX0.0 : BOOL; END_VAR",
    ),
    ["TYPE Point : STRUCT X : INT; END_STRUCT; END_TYPE"],
  );
  expect(value("POINTS[2].X")).toMatchObject({ value: 7 });
  runtime.step();
  expect(value("POINTS[2].X")).toMatchObject({ value: 8 });
  expect(value("link")).toEqual({ kind: "reference", target: "POINTS[2].X" });
  runtime.run();
  clock.advance(10);
  expect(runtime.snapshot().outputs[0]).toBe(1);
  runtime.stop();
  runtime.coldReset();
  expect(value("POINTS[2].X")).toMatchObject({ value: 7 });
  expect(value("link")).toEqual({ kind: "reference", target: null });
});

it("calls shared user and standard FB globals, including arrays, through externals", () => {
  const { runtime, value, ir } = setup(
    [
      `PROGRAM Main VAR_EXTERNAL g : Block; timers : ARRAY[1..2] OF TON; END_VAR
     g(); timers[1](IN := TRUE, PT := LT#1s); END_PROGRAM`,
      "FUNCTION_BLOCK Block VAR_EXTERNAL count : INT; END_VAR VAR_OUTPUT n : INT; END_VAR n := n + 1; count := n; END_FUNCTION_BLOCK",
    ],
    config(
      "VAR_GLOBAL g : Block; timers : ARRAY[1..2] OF TON; count : INT; END_VAR",
      "PROGRAM A WITH T : Main; PROGRAM B WITH T : Main;",
    ),
  );
  runtime.step();
  expect(value("G.N")).toMatchObject({ value: 2 });
  expect(value("count")).toMatchObject({ value: 2 });
  expect(ir.variables.filter((v) => v.kind === "functionBlock").map((v) => v.fbType)).toEqual([
    "TON_LTIME",
    "TON_LTIME",
  ]);
  expect(ir.variables.every((v) => v.global)).toBe(true);
  runtime.coldReset();
  expect(value("G.N")).toMatchObject({ value: 0 });
  runtime.step();
  expect(value("count")).toMatchObject({ value: 2 });
});

it("preserves whole-aggregate reference identity across global external aliases", () => {
  const { runtime, value } = setup(
    [
      `PROGRAM Writer VAR_EXTERNAL g : ARRAY[1..2] OF INT; link : REF_TO ARRAY[1..2] OF INT; END_VAR link := REF(g); END_PROGRAM`,
      `PROGRAM Reader VAR_EXTERNAL g : ARRAY[1..2] OF INT; link : REF_TO ARRAY[1..2] OF INT; END_VAR VAR same : BOOL; END_VAR same := link = REF(g); END_PROGRAM`,
    ],
    config(
      "VAR_GLOBAL g : ARRAY[1..2] OF INT; link : REF_TO ARRAY[1..2] OF INT; END_VAR",
      "PROGRAM A WITH T : Writer; PROGRAM B WITH T : Reader;",
    ),
  );
  runtime.step();
  expect(value("B.same")).toMatchObject({ value: true });
});

it("initializes a global FB whose unused external aliases that same instance", () => {
  const { runtime, value } = setup(
    [
      "PROGRAM Main VAR_EXTERNAL g : Block; END_VAR g(); END_PROGRAM",
      "FUNCTION_BLOCK Block VAR_EXTERNAL g : Block; END_VAR VAR_OUTPUT n : INT; END_VAR n := n + 1; END_FUNCTION_BLOCK",
    ],
    config("VAR_GLOBAL g : Block; END_VAR", "PROGRAM A WITH T : Main; PROGRAM B WITH T : Main;"),
  );
  runtime.step();
  expect(value("G.N")).toMatchObject({ value: 2 });
});

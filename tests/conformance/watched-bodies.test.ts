import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { type BodyWatch, type RuntimeSnapshot } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function setup(sources: string[], configuration?: string) {
  const result = compileProject(sources, [], configuration);
  expect(result.diagnostics).toEqual([]);
  const ir = structuredClone(result.ir!);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  return { runtime, ir, clock };
}
const watch = (pou: string, instance: string): BodyWatch => ({ pou, instance });
const values = (snapshot: RuntimeSnapshot, instance: string, pou?: string) =>
  Object.values(
    snapshot.annotations.find((body) => body.instance === instance && (!pou || body.pou === pou))
      ?.lines ?? {},
  )
    .flat()
    .map((entry) => entry.values);
const counter = `FUNCTION_BLOCK Counter
VAR_INPUT amount: INT; END_VAR
VAR_OUTPUT count: INT; END_VAR
count := count + amount;
END_FUNCTION_BLOCK`;

it("watches two block instances independently", () => {
  const { runtime } = setup([
    `PROGRAM Main VAR a, b: Counter; END_VAR a(amount := 1); b(amount := 7); END_PROGRAM`,
    counter,
  ]);
  runtime.watchBodies([watch("Counter", "mainInstance.A"), watch("Counter", "mainInstance.B")]);
  const snapshot = runtime.step();
  expect(values(snapshot, "mainInstance.A")).toEqual([[{ dataType: "INT", value: 1 }]]);
  expect(values(snapshot, "mainInstance.B")).toEqual([[{ dataType: "INT", value: 7 }]]);
  expect(snapshot.annotations.map((body) => body.pou)).toEqual(["Counter", "Counter"]);
  expect(snapshot.annotations.every((body) => body.scanCount === 1)).toBe(true);
  snapshot.annotations[0]!.lines[4]![0]!.values.length = 0;
  expect(values(runtime.snapshot(), "mainInstance.A")).toHaveLength(1);
  runtime.watchBodies([]);
  expect(runtime.step().annotations).toEqual([]);
});

it("annotates assignment, function/method calls and block calls inside watched block bodies only", () => {
  const { runtime } = setup([
    `PROGRAM Main VAR unit: Outer; END_VAR unit(); END_PROGRAM`,
    `FUNCTION F: INT F := 3; END_FUNCTION`,
    counter,
    `FUNCTION_BLOCK Outer
VAR child: Counter; n: INT; END_VAR
METHOD PUBLIC Get: INT Get := 4; END_METHOD
n := F();
F();
THIS.Get();
child(amount := n);
END_FUNCTION_BLOCK`,
  ]);
  runtime.watchBodies([
    watch("Outer", "mainInstance.UNIT"),
    watch("Counter", "mainInstance.UNIT.CHILD"),
  ]);
  const snapshot = runtime.step();
  expect(values(snapshot, "mainInstance.UNIT")).toEqual([
    [{ dataType: "INT", value: 3 }],
    [{ dataType: "INT", value: 3 }],
    [{ dataType: "INT", value: 4 }],
    [{ dataType: "INT", value: 3 }],
  ]);
  expect(values(snapshot, "mainInstance.UNIT.CHILD")).toEqual([[{ dataType: "INT", value: 3 }]]);
  expect(values(snapshot, "mainInstance.UNIT", "Outer.Get")).toEqual([
    [{ dataType: "INT", value: 4 }],
  ]);
  expect(snapshot.annotations).toHaveLength(3);
});

it.each(["(* inherited body *)", "SUPER(); count := count + 10;"])(
  "shows a derived instance in the base body through %s",
  (body) => {
    const { runtime } = setup([
      `PROGRAM Main VAR unit: Derived; END_VAR unit(amount := 2); END_PROGRAM`,
      counter,
      `FUNCTION_BLOCK Derived EXTENDS Counter ${body} END_FUNCTION_BLOCK`,
    ]);
    runtime.watchBodies([
      watch("Counter", "mainInstance.UNIT"),
      watch("Derived", "mainInstance.UNIT"),
    ]);
    const snapshot = runtime.step();
    expect(values(snapshot, "mainInstance.UNIT", "Counter")).toEqual([
      [{ dataType: "INT", value: 2 }],
    ]);
    expect(values(snapshot, "mainInstance.UNIT", "Derived")).toEqual(
      body.includes("SUPER") ? [[{ dataType: "INT", value: 12 }]] : [],
    );
  },
);

it("retains an invocation's values and scanCount until that instance's body runs again", () => {
  const { runtime } = setup([
    `PROGRAM Main VAR a, b: Counter; first: BOOL := TRUE; END_VAR
IF first THEN a(amount := 1); first := FALSE; ELSE b(amount := 2); END_IF;
END_PROGRAM`,
    counter,
  ]);
  runtime.watchBodies([watch("Counter", "mainInstance.A"), watch("Counter", "mainInstance.B")]);
  const first = runtime.step().annotations[0]!;
  const second = runtime.step();
  expect(second.scanCount).toBe(2);
  expect(second.annotations.find((body) => body.instance === "mainInstance.A")).toEqual(first);
  expect(second.annotations.find((body) => body.instance === "mainInstance.B")?.scanCount).toBe(2);
});

it("replaces the watch set and shows new values from the next task run, including in STOP", () => {
  const { runtime, clock } = setup([
    "PROGRAM Main VAR a, b: Counter; END_VAR a(amount := 1); b(amount := 7); END_PROGRAM",
    counter,
  ]);
  expect(runtime.step().annotations.map((body) => body.pou)).toEqual(["Main"]);
  runtime.watchBodies([watch("Counter", "mainInstance.B")]);
  expect(values(runtime.snapshot(), "mainInstance.B")).toEqual([]);
  expect(values(runtime.step(), "mainInstance.B")).toEqual([[{ dataType: "INT", value: 14 }]]);
  runtime.run();
  runtime.watchBodies([watch("Counter", "mainInstance.A")]);
  clock.advance(9);
  expect(values(runtime.snapshot(), "mainInstance.A")).toEqual([]);
  clock.advance(1);
  expect(values(runtime.snapshot(), "mainInstance.A")).toEqual([[{ dataType: "INT", value: 3 }]]);
});

it("clears a watched body at entry and keeps only statements completed before a fault", () => {
  const { runtime } = setup([
    "PROGRAM Main VAR c: Broken; END_VAR c(); END_PROGRAM",
    `FUNCTION_BLOCK Broken VAR count, n, zero: INT; END_VAR
count := count + 1;
IF count = 1 THEN n := 5; ELSE n := 1 / zero; END_IF;
END_FUNCTION_BLOCK`,
  ]);
  runtime.watchBodies([watch("Broken", "mainInstance.C")]);
  expect(values(runtime.step(), "mainInstance.C")).toHaveLength(2);
  const snapshot = runtime.step();
  expect(runtime.state).toBe("FAULT");
  expect(values(snapshot, "mainInstance.C")).toEqual([[{ dataType: "INT", value: 2 }]]);
  expect(snapshot.annotations[0]?.scanCount).toBe(2);
});

it("watches a second PROGRAM instance and preserves it across warm and cold restarts", () => {
  const { runtime, ir } = setup(
    ["PROGRAM Counter VAR n: INT; END_VAR n := n + 1; END_PROGRAM"],
    "CONFIGURATION C RESOURCE R ON Cpu TASK T(INTERVAL := T#10ms, PRIORITY := 0); PROGRAM A WITH T: Counter; PROGRAM B WITH T: Counter; END_RESOURCE END_CONFIGURATION",
  );
  runtime.write(
    ir.variables.findIndex((v) => v.name === "B.n"),
    { dataType: "INT", value: 40 },
  );
  runtime.watchBodies([watch("Counter", "B")]);
  expect(values(runtime.step(), "B")).toEqual([[{ dataType: "INT", value: 41 }]]);
  runtime.warmRestart();
  expect(runtime.step().annotations.map((body) => body.instance)).toEqual(["B"]);
  runtime.coldReset();
  expect(runtime.step().annotations.map((body) => body.instance)).toEqual(["B"]);
  runtime.load(ir);
  expect(runtime.step().annotations.map((body) => body.instance)).toEqual(["A"]);
});

it("applies watch replacement at the next task boundary when a previous task is paused", () => {
  const result = compileProject([
    "PROGRAM Main VAR a, b: Counter; END_VAR a(amount := 1); b(amount := 7); END_PROGRAM",
    counter,
  ]);
  expect(result.diagnostics).toEqual([]);
  const clock = new VirtualClock();
  let shouldPause = true;
  const runtime = createRuntime({
    clock,
    ticker: new VirtualTicker(clock),
    pause: () => {
      if (!shouldPause) return false;
      shouldPause = false;
      return true;
    },
  });
  runtime.load(result.ir!);
  runtime.watchBodies([watch("Counter", "mainInstance.A")]);
  runtime.step();
  expect(runtime.pauseLocation).not.toBeNull();
  runtime.watchBodies([watch("Counter", "mainInstance.B")]);
  const completed = runtime.resume();
  // The interrupted task finishes with the watch set it captured at entry.
  expect(completed.annotations.map((body) => body.instance)).toEqual(["mainInstance.A"]);
  const next = runtime.step();
  expect(next.annotations.map((body) => body.instance)).toEqual(["mainInstance.B"]);
  expect(values(next, "mainInstance.B")).toEqual([[{ dataType: "INT", value: 14 }]]);
});

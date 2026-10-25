import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable, type ConfigurationIR } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

const valve = `CLASS Valve
VAR PUBLIC Position: INT := 5; END_VAR
VAR PRIVATE opened: BOOL; END_VAR
VAR CONSTANT maxPosition: INT := 100; END_VAR
METHOD PUBLIC Open
 VAR fresh: INT := 1; END_VAR
 fresh := fresh + 1;
 THIS.opened := TRUE; Position := maxPosition + fresh - 2;
END_METHOD
METHOD PUBLIC Close THIS.opened := FALSE; Position := 0; END_METHOD
METHOD PUBLIC IsOpen : BOOL IsOpen := THIS.opened; END_METHOD
END_CLASS`;

function setup(sources: string[], configuration?: string) {
  const result = compileProject(sources, [], configuration);
  expect(result.diagnostics).toEqual([]);
  const ir: ConfigurationIR = structuredClone(result.ir!);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  runtime.watch(ir.variables.map((_, id) => id));
  const id = (name: string) => ir.variables.findIndex((v) => v.key === name.toUpperCase());
  const value = (name: string) => snapshotVariable(runtime.snapshot(), id(name));
  return { ir, runtime, id, value };
}

it("traces Valve Open, Close and IsOpen with independent array instances and fresh method locals", () => {
  const { runtime, value, ir } = setup([
    `PROGRAM Main VAR valves: ARRAY[1..2] OF Valve; choose: INT := 1; seen: BOOL; END_VAR
    valves[choose].Open(); valves[3 - choose].Close(); seen := valves[choose].IsOpen();
    END_PROGRAM`,
    valve,
  ]);
  expect(value("mainInstance.valves[1].Position")).toMatchObject({ value: 5 });
  runtime.step();
  expect(value("mainInstance.valves[1].Position")).toMatchObject({ value: 100 });
  expect(value("mainInstance.valves[1].opened")).toMatchObject({ value: true });
  expect(value("mainInstance.valves[2].Position")).toMatchObject({ value: 0 });
  expect(value("mainInstance.seen")).toMatchObject({ value: true });
  runtime.step();
  expect(value("mainInstance.valves[1].Position")).toMatchObject({ value: 100 });
  expect(ir.variables.some((v) => /maxPosition|fresh/i.test(v.name))).toBe(false);
});

it("writes and forces private class members through the monitor", () => {
  const { runtime, id, value } = setup(["PROGRAM Main VAR v: Valve; END_VAR END_PROGRAM", valve]);
  runtime.write(id("mainInstance.v.opened"), { dataType: "BOOL", value: true });
  runtime.step();
  expect(value("mainInstance.v.opened")).toMatchObject({ value: true });
  runtime.force(id("mainInstance.v.opened"), { dataType: "BOOL", value: false });
  runtime.step();
  expect(value("mainInstance.v.opened")).toMatchObject({ value: false });
  expect(runtime.snapshot().forced).toContain(id("mainInstance.v.opened"));
});

it("traces retention inheritance, overrides, cold reset and reload for class members", () => {
  const sources = [
    `PROGRAM Main VAR RETAIN v: Counter; END_VAR
    VAR normal: Counter; END_VAR v.Tick(); normal.Tick(); END_PROGRAM`,
    `CLASS Counter
    VAR n: INT := 1; END_VAR
    VAR RETAIN kept: INT := 2; END_VAR
    VAR NON_RETAIN reset: INT := 3; END_VAR
    METHOD PUBLIC Tick n := n + 1; kept := kept + 1; reset := reset + 1; END_METHOD
    END_CLASS`,
  ];
  const first = setup(sources);
  first.runtime.step();
  first.runtime.step();
  first.runtime.warmRestart();
  for (const [name, expected] of Object.entries({
    "v.n": 3,
    "v.kept": 4,
    "v.reset": 3,
    "normal.n": 1,
    "normal.kept": 4,
    "normal.reset": 3,
  }))
    expect(first.value(`mainInstance.${name}`)).toMatchObject({ value: expected });
  const reloaded = setup(sources);
  expect(
    reloaded.runtime.restoreRetentive(JSON.parse(JSON.stringify(first.runtime.retentiveRecords()))),
  ).toEqual([]);
  expect(reloaded.value("mainInstance.v.n")).toMatchObject({ value: 3 });
  expect(reloaded.value("mainInstance.normal.kept")).toMatchObject({ value: 4 });
  expect(reloaded.value("mainInstance.v.reset")).toMatchObject({ value: 3 });
  first.runtime.coldReset();
  expect(first.value("mainInstance.v.n")).toMatchObject({ value: 1 });
  expect(first.value("mainInstance.v.kept")).toMatchObject({ value: 2 });
});

it("calls nested class and function block instances with THIS and global external bindings", () => {
  const { runtime, value } = setup(
    [
      "PROGRAM Main VAR o: Owner; seen: BOOL; END_VAR o.Run(); seen := o.Value(); END_PROGRAM",
      `CLASS Owner VAR children: ARRAY[1..2] OF Valve; b: Block; END_VAR
    VAR_EXTERNAL globalValve: Valve; END_VAR
    METHOD PUBLIC Run THIS.children[2].Open(); globalValve.Open(); THIS.b(); END_METHOD
    METHOD PUBLIC Value : BOOL Value := THIS.children[2].IsOpen() AND globalValve.IsOpen(); END_METHOD
    END_CLASS`,
      valve,
      "FUNCTION_BLOCK Block VAR n: INT; END_VAR n := n + 1; END_FUNCTION_BLOCK",
    ],
    `CONFIGURATION C VAR_GLOBAL globalValve: Valve; END_VAR RESOURCE R ON Cpu
  TASK T (INTERVAL := T#10ms, PRIORITY := 0); PROGRAM P WITH T : Main; END_RESOURCE END_CONFIGURATION`,
  );
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("P.seen")).toMatchObject({ value: true });
  expect(value("P.o.b.n")).toMatchObject({ value: 1 });
  expect(value("globalValve.opened")).toMatchObject({ value: true });
});

it("attributes a class method fault to its source and instance", () => {
  const { runtime } = setup([
    "PROGRAM Main VAR v: Broken; END_VAR v.Fail(); END_PROGRAM",
    "CLASS Broken METHOD PUBLIC Fail VAR x,y: INT; END_VAR x := 1 / y; END_METHOD END_CLASS",
  ]);
  runtime.step();
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.division-by-zero",
    pou: "Broken.Fail",
    instance: "mainInstance.V",
  });
});

it("traces public nested scalar members and calls block arrays through a class", () => {
  const { runtime, value } = setup([
    `PROGRAM Main VAR h: Holder; seen: INT; ready: BOOL; END_VAR
    h.item.x := 3; seen := h.item.x;
    h.blocks[1](Step := 4); h.timers[2](IN := TRUE, PT := T#0s, Q => ready);
    END_PROGRAM`,
    `CLASS Holder VAR PUBLIC item: Child; blocks: ARRAY[1..2] OF CountBlock;
    timers: ARRAY[1..2] OF TON; END_VAR END_CLASS`,
    "CLASS Child VAR PUBLIC x: INT; END_VAR END_CLASS",
    "FUNCTION_BLOCK CountBlock VAR_INPUT Step: INT; END_VAR VAR n: INT; END_VAR n := n + Step; END_FUNCTION_BLOCK",
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("mainInstance.seen")).toMatchObject({ value: 3 });
  expect(value("mainInstance.h.blocks[1].n")).toMatchObject({ value: 4 });
  expect(value("mainInstance.ready")).toMatchObject({ value: true });
});

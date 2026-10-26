import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable, type DebugStepKind } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function setup(sources: string[], configuration?: string, types: string[] = []) {
  const compiled = compileProject(sources, types, configuration);
  expect(compiled.diagnostics).toEqual([]);
  const ir = structuredClone(compiled.ir!);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  runtime.watch(ir.variables.map((_, id) => id));
  const frames = () => runtime.halted?.frames.map((f) => [f.kind, f.pou, f.instance, f.span.line]);
  const at = (pou: string, line: number) => {
    runtime.setBreakpoints([{ pou, line }]);
    runtime.step();
    expect(runtime.state).toBe("HALT");
    runtime.setBreakpoints([]);
  };
  const value = (name: string) =>
    snapshotVariable(
      runtime.snapshot(),
      ir.variables.findIndex((v) => v.key === name.toUpperCase()),
    );
  return { runtime, clock, ir, frames, at, value };
}
const main = `PROGRAM Main
VAR x: INT := 3; y: INT; END_VAR
y := Scale(x) + Offset(x);
x := y;
END_PROGRAM`;
const scale = `FUNCTION Scale: INT
VAR_INPUT v: INT; END_VAR
Scale := v * 2;
END_FUNCTION`;
const offset = `FUNCTION Offset: INT
VAR_INPUT v: INT; END_VAR
VAR tmp: INT; END_VAR
tmp := v + 1;
Offset := tmp;
END_FUNCTION`;

it("enters each call in evaluation order without halting in the middle of the caller statement", () => {
  const { runtime, at, frames, value } = setup([main, scale, offset]);
  runtime.watchBodies([]);
  at("Main", 3);
  expect(frames()).toEqual([["PROGRAM", "Main", "mainInstance", 3]]);
  runtime.debugStep("into");
  expect(frames()).toEqual([
    ["FUNCTION", "Scale", null, 3],
    ["PROGRAM", "Main", "mainInstance", 3],
  ]);
  expect(runtime.halted?.frames[0]?.values).toEqual([
    { name: "v", value: { dataType: "INT", value: 3 } },
    { name: "Scale", value: { dataType: "INT", value: 0 } },
  ]);
  expect(runtime.halted?.frames[1]?.task).toBe("Cyclic");
  runtime.debugStep("into");
  expect(frames()).toEqual([
    ["FUNCTION", "Offset", null, 4],
    ["PROGRAM", "Main", "mainInstance", 3],
  ]);
  runtime.debugStep("over");
  expect(frames()).toEqual([
    ["FUNCTION", "Offset", null, 5],
    ["PROGRAM", "Main", "mainInstance", 3],
  ]);
  expect(runtime.halted?.frames[0]?.annotations[4]?.[0]?.values).toEqual([
    { dataType: "INT", value: 4 },
  ]);
  runtime.debugStep("out");
  expect(frames()).toEqual([["PROGRAM", "Main", "mainInstance", 4]]);
  expect(value("mainInstance.y")).toMatchObject({ value: 10 });
  expect(runtime.halted?.frames[0]?.annotations[3]?.[0]?.values).toEqual([
    { dataType: "INT", value: 10 },
  ]);
  // Public frames and values are copies, and carry unwatched invocation annotations.
  runtime.halted!.frames[0]!.annotations[3]![0]!.values.length = 0;
  expect(runtime.halted?.frames[0]?.annotations[3]?.[0]?.values).toHaveLength(1);
  runtime.debugStep("out");
  expect(runtime.state).toBe("STOP");
  expect(value("mainInstance.x")).toMatchObject({ value: 10 });
});

it.each(["over", "out"] as const)("%s skips sibling calls after leaving a function", (kind) => {
  const { runtime, at, frames } = setup([main, scale, offset]);
  at("Main", 3);
  runtime.debugStep("into");
  runtime.debugStep(kind);
  expect(frames()).toEqual([["PROGRAM", "Main", "mainInstance", 4]]);
});

it("lets a callee breakpoint interrupt step over once and cancel its target", () => {
  const { runtime, at, frames } = setup([main, scale, offset]);
  at("Main", 3);
  runtime.setBreakpoints([{ pou: "Offset", line: 5 }]);
  runtime.debugStep("over");
  expect(frames()).toEqual([
    ["FUNCTION", "Offset", null, 5],
    ["PROGRAM", "Main", "mainInstance", 3],
  ]);
  runtime.continue();
  expect(runtime.state).toBe("STOP");
});

it("steps over a FOR body once per iteration and skips a branch that does not run", () => {
  const { runtime, at, frames } = setup([
    `PROGRAM Main
VAR a,b: INT; END_VAR
VAR_TEMP i: INT; END_VAR
FOR i := 1 TO 2 DO
 a := a + i;
END_FOR;
IF FALSE THEN a := 99; END_IF;
b := a;
END_PROGRAM`,
  ]);
  at("Main", 4);
  for (const [line, i] of [
    [5, 1],
    [5, 2],
    [7, 3],
    [8, 3],
  ]) {
    runtime.debugStep("over");
    expect(frames()).toEqual([["PROGRAM", "Main", "mainInstance", line]]);
    expect(runtime.halted?.frames[0]?.values).toEqual([
      { name: "i", value: { dataType: "INT", value: i } },
    ]);
  }
});

it("enters function blocks and treats standard functions and blocks as one step", () => {
  const { runtime, at, frames } = setup([
    `PROGRAM Main
VAR unit: Box; timer: TON; n: INT; END_VAR
unit();
timer(IN := TRUE, PT := T#1s);
n := ABS(INT#-3);
unit();
END_PROGRAM`,
    `FUNCTION_BLOCK Box
VAR n: INT; END_VAR
VAR_TEMP scratch: INT := 2; END_VAR
n := n + scratch;
END_FUNCTION_BLOCK`,
  ]);
  at("Main", 3);
  runtime.debugStep("into");
  expect(frames()).toEqual([
    ["FUNCTION_BLOCK", "Box", "mainInstance.UNIT", 4],
    ["PROGRAM", "Main", "mainInstance", 3],
  ]);
  expect(runtime.halted?.frames[0]?.values).toEqual([
    { name: "scratch", value: { dataType: "INT", value: 2 } },
  ]);
  for (const line of [4, 5, 6]) {
    runtime.debugStep("into");
    expect(frames()).toEqual([["PROGRAM", "Main", "mainInstance", line]]);
  }
});

const base = `CLASS Base
METHOD PUBLIC Apply: INT
Apply := 1;
END_METHOD
END_CLASS`;
const derived = `CLASS Motor EXTENDS Base IMPLEMENTS IActuator
METHOD PUBLIC OVERRIDE Apply: INT
Apply := SUPER.Apply() + 2;
END_METHOD
METHOD PUBLIC Run: INT
Run := THIS.Apply();
END_METHOD
END_CLASS`;
it.each(["interface", "reference", "THIS"])(
  "steps through %s dispatch and SUPER with the declaring type's code",
  (dispatch) => {
    const expression =
      dispatch === "interface"
        ? "actuator.Apply()"
        : dispatch === "reference"
          ? "link^.Apply()"
          : "drive.Run()";
    const { runtime, at, frames } = setup([
      `PROGRAM Main
VAR drive: Motor; actuator: IActuator; link: REF_TO Base; n: INT; END_VAR
actuator := drive;
link := REF(drive);
n := ${expression};
n := n + 1;
END_PROGRAM`,
      "INTERFACE IActuator METHOD Apply: INT END_METHOD END_INTERFACE",
      base,
      derived,
    ]);
    at("Main", 5);
    runtime.debugStep("into");
    if (dispatch === "THIS") {
      expect(frames()).toEqual([
        ["METHOD", "Motor.Run", "mainInstance.DRIVE", 6],
        ["PROGRAM", "Main", "mainInstance", 5],
      ]);
      runtime.debugStep("into");
    }
    const callers = dispatch === "THIS" ? [["METHOD", "Motor.Run", "mainInstance.DRIVE", 6]] : [];
    expect(frames()).toEqual([
      ["METHOD", "Motor.Apply", "mainInstance.DRIVE", 3],
      ...callers,
      ["PROGRAM", "Main", "mainInstance", 5],
    ]);
    runtime.debugStep("into");
    expect(frames()).toEqual([
      ["METHOD", "Base.Apply", "mainInstance.DRIVE", 3],
      ["METHOD", "Motor.Apply", "mainInstance.DRIVE", 3],
      ...callers,
      ["PROGRAM", "Main", "mainInstance", 5],
    ]);
    runtime.debugStep("out");
    expect(frames()).toEqual([["PROGRAM", "Main", "mainInstance", 6]]);
  },
);

it("steps through SUPER bodies without changing receiver paths", () => {
  const { runtime, at, frames } = setup([
    "PROGRAM Main VAR block: Derived; n: INT; END_VAR\nblock();\nn := 1;\nEND_PROGRAM",
    "FUNCTION_BLOCK Base VAR n: INT; END_VAR\nn := n + 1;\nEND_FUNCTION_BLOCK",
    "FUNCTION_BLOCK Derived EXTENDS Base\nSUPER();\nn := n + 2;\nEND_FUNCTION_BLOCK",
  ]);
  at("Main", 2);
  runtime.debugStep("into");
  expect(frames()).toEqual([
    ["FUNCTION_BLOCK", "Derived", "mainInstance.BLOCK", 2],
    ["PROGRAM", "Main", "mainInstance", 2],
  ]);
  runtime.debugStep("into");
  expect(frames()).toEqual([
    ["FUNCTION_BLOCK", "Base", "mainInstance.BLOCK", 2],
    ["FUNCTION_BLOCK", "Derived", "mainInstance.BLOCK", 2],
    ["PROGRAM", "Main", "mainInstance", 2],
  ]);
  runtime.debugStep("out");
  expect(frames()).toEqual([
    ["FUNCTION_BLOCK", "Derived", "mainInstance.BLOCK", 3],
    ["PROGRAM", "Main", "mainInstance", 2],
  ]);
});

it("reports in-out actuals in caller locals, including members/indices and alias forwarding", () => {
  const { runtime, at, frames } = setup(
    [
      "PROGRAM Main VAR resultValue: INT; END_VAR\nresultValue := G();\nEND_PROGRAM",
      `FUNCTION G: INT
VAR tmp: ARRAY[1..2] OF Item; END_VAR
tmp[2].level := 7;
G := H(x := tmp[2].level);
END_FUNCTION`,
      "FUNCTION H: INT VAR_IN_OUT x: INT; END_VAR\nH := F(x := x);\nEND_FUNCTION",
      "FUNCTION F: INT VAR_IN_OUT x: INT; END_VAR\nx := x + 1;\nF := x;\nEND_FUNCTION",
    ],
    undefined,
    ["TYPE Item: STRUCT level: INT; END_STRUCT; END_TYPE"],
  );
  at("F", 3);
  expect(frames()).toEqual([
    ["FUNCTION", "F", null, 3],
    ["FUNCTION", "H", null, 2],
    ["FUNCTION", "G", null, 4],
    ["PROGRAM", "Main", "mainInstance", 2],
  ]);
  for (const frame of runtime.halted!.frames.slice(0, 2))
    expect(frame.values).toContainEqual({
      name: "x",
      value: { dataType: "INT", value: 8 },
      actual: { frame: 2, name: "tmp[2].level" },
    });
  expect(runtime.halted!.frames[2]!.values[0]).toMatchObject({
    name: "tmp",
    value: { kind: "aggregate" },
  });
});

it("reports path-bound PROGRAM and function in-outs by formal name", () => {
  const { runtime, at } = setup(
    [
      "PROGRAM Main VAR_IN_OUT Level: IEmpty; END_VAR VAR resultValue: INT; END_VAR\nresultValue := F(x := Level);\nEND_PROGRAM",
      "FUNCTION F: INT VAR_IN_OUT x: IEmpty; END_VAR\nx := x;\nF := 1;\nEND_FUNCTION",
      "INTERFACE IEmpty END_INTERFACE",
    ],
    `CONFIGURATION C VAR_GLOBAL actual: IEmpty; END_VAR RESOURCE R ON Cpu
TASK T(INTERVAL := T#10ms, PRIORITY := 0); PROGRAM P WITH T: Main(Level := actual);
END_RESOURCE END_CONFIGURATION`,
  );
  at("F", 3);
  expect(runtime.halted!.frames[0]!.values).toContainEqual({
    name: "x",
    value: { kind: "reference", target: null },
    actual: { path: "actual" },
  });
  expect(runtime.halted!.frames[1]!.values).toEqual([
    { name: "Level", value: { kind: "reference", target: null }, actual: { path: "actual" } },
  ]);
});

const scheduled = `CONFIGURATION C RESOURCE R ON Cpu
TASK Fast(INTERVAL := T#10ms, PRIORITY := 0);
TASK Slow(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM A WITH Fast: Main;
PROGRAM B WITH Fast: Main;
PROGRAM S WITH Slow: Main;
END_RESOURCE END_CONFIGURATION`;
const oneStatement = "PROGRAM Main VAR n: INT; END_VAR\nn := n + 1;\nEND_PROGRAM";
it.each(["over", "into", "out"] as const)(
  "%s past a PROGRAM end halts in the next instance, task and later pass",
  (kind) => {
    const { runtime, clock, frames } = setup([oneStatement], scheduled);
    runtime.setBreakpoints([{ pou: "Main", line: 2 }]);
    runtime.run();
    clock.advance(10);
    runtime.setBreakpoints([]);
    expect(frames()).toEqual([["PROGRAM", "Main", "A", 2]]);
    runtime.debugStep(kind);
    expect(frames()).toEqual([["PROGRAM", "Main", "B", 2]]);
    runtime.debugStep(kind);
    expect(frames()).toEqual([["PROGRAM", "Main", "S", 2]]);
    runtime.debugStep(kind);
    expect(runtime.state).toBe("RUN");
    expect(runtime.halted).toBeNull();
    expect(() => runtime.continue()).toThrow("runtime.not-halted");
    expect(() => runtime.debugStep(kind)).toThrow("runtime.not-halted");
    clock.advance(10);
    expect(frames()).toEqual([["PROGRAM", "Main", "A", 2]]);
    runtime.continue();
    expect(runtime.state).toBe("RUN");
    clock.advance(100);
    expect(runtime.state).toBe("RUN");
    runtime.stop();
  },
);

it.each(["stop", "warmRestart", "coldReset", "load", "estop"] as const)(
  "%s cancels a step waiting for a later pass",
  (command) => {
    const { runtime, clock, ir, at } = setup([oneStatement]);
    at("Main", 2);
    runtime.continue();
    runtime.setBreakpoints([{ pou: "Main", line: 2 }]);
    runtime.run();
    clock.advance(10);
    runtime.setBreakpoints([]);
    runtime.debugStep("out");
    expect(runtime.state).toBe("RUN");
    if (command === "load") runtime.load(ir);
    else if (command === "estop") {
      runtime.setEmergencyStop(true);
      runtime.setEmergencyStop(false);
    } else runtime[command]();
    runtime.run();
    clock.advance(20);
    expect(runtime.state).toBe("RUN");
    runtime.stop();
  },
);

it("cancels steps on faults and rejects every step kind outside a halt", () => {
  const { runtime, at } = setup([
    "PROGRAM Main VAR n,zero: INT; END_VAR\nn := 1 / zero;\nEND_PROGRAM",
  ]);
  for (const kind of ["over", "into", "out"] satisfies DebugStepKind[])
    expect(() => runtime.debugStep(kind)).toThrow("runtime.not-halted");
  at("Main", 2);
  runtime.debugStep("over");
  expect(runtime.state).toBe("FAULT");
  runtime.coldReset();
  runtime.step();
  expect(runtime.state).toBe("FAULT");
});

it("reports method inputs, outputs, locals, interface temporaries, result and live path aliases", () => {
  const { runtime, at } = setup([
    "PROGRAM Main VAR unit: Box; actual: INT := 7; n: INT; END_VAR\nn := unit.Add(x := 3, value := actual);\nEND_PROGRAM",
    `CLASS Box
METHOD PUBLIC Add: INT
VAR_INPUT x: INT; END_VAR
VAR_OUTPUT outputValue: INT; END_VAR
VAR_IN_OUT value: INT; END_VAR
VAR local: INT; END_VAR
VAR_TEMP scratch: IEmpty; END_VAR
local := x + 1;
value := local;
outputValue := value + 1;
Add := outputValue;
RETURN;
END_METHOD
END_CLASS`,
    "INTERFACE IEmpty END_INTERFACE",
  ]);
  at("Box.Add", 12);
  expect(
    Object.fromEntries(runtime.halted!.frames[0]!.values.map((v) => [v.name, v.value])),
  ).toEqual({
    x: { dataType: "INT", value: 3 },
    outputValue: { dataType: "INT", value: 5 },
    value: { dataType: "INT", value: 4 },
    local: { dataType: "INT", value: 4 },
    scratch: { kind: "reference", target: null },
    Add: { dataType: "INT", value: 5 },
  });
  expect(runtime.halted!.frames[0]!.values.find((v) => v.name === "value")?.actual).toEqual({
    path: "mainInstance.actual",
  });
});

it.each(["while", "repeat"] as const)(
  "attributes calls in repeated %s conditions to the compound statement without halting at its condition again",
  (kind) => {
    const loop =
      kind === "while"
        ? "WHILE Check(n) DO\n n := n + 1;\nEND_WHILE;"
        : "REPEAT\n n := n + 1;\nUNTIL Check(n) END_REPEAT;";
    const condition = kind === "while" ? "n < 2" : "n >= 2";
    const { runtime, at, frames } = setup([
      `PROGRAM Main VAR n: INT; END_VAR\n${loop}\nn := 9;\nEND_PROGRAM`,
      `FUNCTION Check: BOOL VAR_INPUT n: INT; END_VAR\nCheck := ${condition};\nEND_FUNCTION`,
    ]);
    at("Check", 2);
    runtime.debugStep("out");
    expect(frames()).toEqual([["PROGRAM", "Main", "mainInstance", 3]]);
    runtime.debugStep("into");
    expect(frames()).toEqual([
      ["FUNCTION", "Check", null, 2],
      ["PROGRAM", "Main", "mainInstance", 2],
    ]);
  },
);

it("keeps a step pending through empty passes until a later event activation", () => {
  const ir = compileProject(
    [oneStatement],
    [],
    `CONFIGURATION C RESOURCE R ON Cpu
TASK Event(SINGLE := %IX0.0, PRIORITY := 0); PROGRAM P WITH Event: Main;
END_RESOURCE END_CONFIGURATION`,
  ).ir!;
  const clock = new VirtualClock();
  const inputs = Array<number>(64).fill(0);
  const runtime = createRuntime({
    clock,
    ticker: new VirtualTicker(clock),
    stages: { readInputs: () => inputs },
  });
  runtime.load(ir);
  runtime.setBreakpoints([{ pou: "Main", line: 2 }]);
  runtime.run();
  inputs[0] = 1;
  clock.advance(10);
  expect(runtime.state).toBe("HALT");
  runtime.setBreakpoints([]);
  runtime.debugStep("out");
  clock.advance(100);
  expect(runtime.state).toBe("RUN");
  expect(() => runtime.debugStep("into")).toThrow("runtime.not-halted");
  inputs[0] = 0;
  clock.advance(10);
  inputs[0] = 1;
  clock.advance(10);
  expect(runtime.halted).toMatchObject({
    task: "Event",
    frames: [{ pou: "Main", instance: "P", span: { line: 2 } }],
  });
  runtime.stop();
});

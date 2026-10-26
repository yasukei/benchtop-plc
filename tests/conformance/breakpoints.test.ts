import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable, type ConfigurationIR } from "@benchtop-plc/core";
import {
  createRuntime,
  VirtualClock,
  VirtualTicker,
  type RuntimeOptions,
} from "@benchtop-plc/runtime";

function compile(sources: string[], configuration?: string) {
  const result = compileProject(sources, [], configuration);
  expect(result.diagnostics).toEqual([]);
  return result.ir!;
}
function setup(ir: ConfigurationIR, options: Partial<RuntimeOptions> = {}) {
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock), ...options });
  runtime.load(ir);
  runtime.watch(ir.variables.map((_, id) => id));
  const id = (path: string) => ir.variables.findIndex((v) => v.key === path.toUpperCase());
  const value = (path: string) => snapshotVariable(runtime.snapshot(), id(path));
  return { runtime, clock, value, id };
}
const source = `PROGRAM Main
VAR n: INT; inputValue AT %IX0.0: BOOL; outputValue AT %QX0.0: BOOL; END_VAR
n := n + 1;
outputValue := inputValue;
END_PROGRAM`;
const ir = compile([source]);

it.each([false, true])(
  "continues a halted run over RUN=%s and preserves the published output image",
  (running) => {
    const inputs = Array<number>(64).fill(0);
    inputs[0] = 1;
    const { runtime, clock, value } = setup(ir, { stages: { readInputs: () => inputs } });
    if (running) runtime.run();
    runtime.scanOnce();
    expect(runtime.snapshot().outputs[0]).toBe(running ? 1 : 0);
    runtime.setBreakpoints([
      { pou: "Main", line: 4 },
      { pou: "Main", line: 2 },
    ]);
    runtime.scanOnce();
    expect(runtime.state).toBe("HALT");
    expect(runtime.halted).toMatchObject({
      operatingState: running ? "RUN" : "STOP",
      task: "Cyclic",
      frames: [{ kind: "PROGRAM", pou: "Main", instance: "mainInstance", span: { line: 4 } }],
    });
    expect(value("mainInstance.n")).toMatchObject({ value: 2 });
    inputs[0] = 0;
    clock.advance(5000);
    expect(runtime.snapshot().outputs[0]).toBe(running ? 1 : 0);
    expect(runtime.snapshot().scanCount).toBe(1);
    for (const command of [
      () => runtime.run(),
      () => runtime.step(),
      () => runtime.scanOnce(),
      () => runtime.setCycle(20),
    ])
      expect(command).toThrow("runtime.halted");
    runtime.continue();
    expect(runtime.state).toBe(running ? "RUN" : "STOP");
    expect(value("mainInstance.outputValue")).toMatchObject({ value: running });
    expect(runtime.snapshot().lastExecutionTimeMs).toBe(0);
    expect(runtime.snapshot().tasks[0]).toMatchObject({
      runCount: 2,
      lastExecutionTimeMs: 0,
      maxExecutionTimeMs: 0,
      overruns: 0,
    });
    expect(() => runtime.continue()).toThrow("runtime.not-halted");
    runtime.stop();
  },
);

it.each(["stop", "estop"] as const)(
  "%s abandons a halted run without task telemetry, but counts its pass",
  (command) => {
    const { runtime, clock, value } = setup(ir);
    runtime.run();
    clock.advance(10);
    const before = runtime.snapshot();
    runtime.setBreakpoints([{ pou: "Main", line: 4 }]);
    clock.advance(10);
    expect(runtime.state).toBe("HALT");
    clock.advance(5000);
    if (command === "stop") runtime.stop();
    else runtime.setEmergencyStop(true);
    expect(runtime.snapshot().tasks).toEqual(before.tasks);
    expect(runtime.snapshot().lastExecutionTimeMs).toBe(before.lastExecutionTimeMs);
    expect(runtime.snapshot().scanCount).toBe(before.scanCount + 1);
    expect(value("mainInstance.n")).toMatchObject({ value: 2 });
    expect(runtime.halted).toBeNull();
    if (command === "estop") {
      expect(runtime.state).toBe("ESTOP");
      runtime.setEmergencyStop(false);
    }
    runtime.setBreakpoints([]);
    runtime.run();
    clock.advance(9);
    expect(runtime.snapshot().scanCount).toBe(2);
    clock.advance(1);
    expect(runtime.snapshot().tasks[0]).toMatchObject({ runCount: 2, overruns: 0 });
    runtime.stop();
  },
);

it.each(["load", "warmRestart", "coldReset"] as const)(
  "%s abandons a halt and initializes a new STOP schedule",
  (command) => {
    const { runtime, clock } = setup(ir);
    runtime.setBreakpoints([{ pou: "Main", line: 4 }]);
    runtime.run();
    clock.advance(10);
    if (command === "load") runtime.load(ir);
    else runtime[command]();
    expect(runtime.state).toBe("STOP");
    expect(runtime.halted).toBeNull();
    expect(runtime.snapshot().scanCount).toBe(0);
    expect(runtime.snapshot().tasks[0]?.runCount).toBe(0);
    runtime.setBreakpoints([]);
    runtime.run();
    clock.advance(10);
    expect(runtime.snapshot().scanCount).toBe(1);
    runtime.stop();
  },
);

it("halts each loop invocation and derived instance running base code and computes the uninterrupted result", () => {
  const compiled = compile([
    `PROGRAM Main VAR counters: ARRAY[1..4] OF Derived; i: INT; END_VAR
FOR i := 1 TO 4 DO counters[i](); END_FOR;
END_PROGRAM`,
    `FUNCTION_BLOCK Base VAR_OUTPUT Count: INT; END_VAR
Count := Count + 1;
END_FUNCTION_BLOCK`,
    `FUNCTION_BLOCK Derived EXTENDS Base END_FUNCTION_BLOCK`,
  ]);
  const baseline = setup(compiled).runtime.scanOnce();
  const { runtime } = setup(compiled);
  runtime.setBreakpoints([{ pou: "Base", line: 2 }]);
  runtime.step();
  for (let i = 1; i <= 4; i++) {
    expect(runtime.halted?.frames[0]).toMatchObject({
      kind: "FUNCTION_BLOCK",
      pou: "Base",
      instance: `mainInstance.COUNTERS[${i}]`,
      span: { line: 2 },
    });
    runtime.continue();
  }
  expect(runtime.state).toBe("STOP");
  expect(runtime.snapshot()).toEqual(baseline);
});

it("reports functions and methods, applies breakpoint changes immediately and watches only on the next task run", () => {
  const compiled = compile([
    `PROGRAM Main VAR c: Counter; n: INT; END_VAR
n := PlusOne(c.Count());
END_PROGRAM`,
    `CLASS Counter VAR n: INT; END_VAR
METHOD PUBLIC Count: INT
n := n + 1;
Count := n;
END_METHOD
END_CLASS`,
    `FUNCTION PlusOne: INT VAR_INPUT n: INT; END_VAR
PlusOne := n + 1;
END_FUNCTION`,
  ]);
  const { runtime } = setup(compiled);
  runtime.setBreakpoints([{ pou: "Counter", line: 4 }]);
  runtime.step();
  expect(runtime.halted?.frames[0]).toMatchObject({
    kind: "METHOD",
    pou: "Counter.Count",
    instance: "mainInstance.C",
  });
  runtime.watchBodies([{ pou: "Counter", instance: "mainInstance.C" }]);
  expect(runtime.snapshot().annotations.some((body) => body.pou === "Counter.Count")).toBe(false);
  runtime.setBreakpoints([{ pou: "PlusOne", line: 2 }]);
  runtime.continue();
  expect(runtime.halted?.frames[0]).toMatchObject({
    kind: "FUNCTION",
    pou: "PlusOne",
    instance: null,
  });
  runtime.setBreakpoints([]);
  runtime.continue();
  runtime.step();
  expect(runtime.snapshot().annotations).toContainEqual(
    expect.objectContaining({ pou: "Counter.Count", instance: "mainInstance.C" }),
  );
});

it("writes immediately at a halt, consumes writes to forced variables and defers force changes", () => {
  const { runtime, value, id } = setup(ir);
  runtime.force(id("mainInstance.n"), { dataType: "INT", value: 50 });
  runtime.setBreakpoints([{ pou: "Main", line: 3 }]);
  runtime.step();
  runtime.write(id("mainInstance.n"), { dataType: "INT", value: 99 });
  expect(value("mainInstance.n")).toMatchObject({ value: 50 });
  runtime.force(id("mainInstance.n"), null);
  runtime.write(id("mainInstance.n"), { dataType: "INT", value: 7 });
  expect(value("mainInstance.n")).toMatchObject({ value: 7 });
  runtime.force(id("mainInstance.n"), { dataType: "INT", value: 100 });
  expect(value("mainInstance.n")).toMatchObject({ value: 7 });
  runtime.continue();
  expect(value("mainInstance.n")).toMatchObject({ value: 100 });
});

it("a resumed fault ends the halt and counts the faulting task", () => {
  const compiled = compile([
    `PROGRAM Main VAR n, zero: INT; END_VAR
n := 1 / zero;
END_PROGRAM`,
  ]);
  const { runtime, clock } = setup(compiled);
  runtime.setBreakpoints([{ pou: "Main", line: 2 }]);
  runtime.step();
  clock.advance(5000);
  runtime.continue();
  expect(runtime.state).toBe("FAULT");
  expect(runtime.halted).toBeNull();
  expect(runtime.diagnostic?.code).toBe("runtime.division-by-zero");
  expect(runtime.snapshot()).toMatchObject({
    scanCount: 1,
    lastExecutionTimeMs: 0,
    tasks: [{ runCount: 1, lastExecutionTimeMs: 0, overruns: 0 }],
  });
});

it("keeps the watchdog budget before and after halting", () => {
  const compiled = compile([
    `PROGRAM Main VAR n, i: DINT; END_VAR
FOR i := 1 TO 200001 DO
n := n + 1;
IF n = 100000 THEN
n := n;
END_IF;
END_FOR;
END_PROGRAM`,
  ]);
  const { runtime, value } = setup(compiled);
  runtime.setBreakpoints([{ pou: "Main", line: 5 }]);
  runtime.step();
  expect(value("mainInstance.n")).toMatchObject({ value: 100000 });
  runtime.setBreakpoints([]);
  runtime.continue();
  expect(runtime.diagnostic?.code).toBe("runtime.watchdog");
  expect(value("mainInstance.n")).toMatchObject({ value: 200000 });
});

it("excludes a 12–5012 ms halt from Fast and Slow execution times and skipped activations", () => {
  const compiled = compile(
    [
      `PROGRAM Main VAR n: INT; END_VAR
n := n + 1;
END_PROGRAM`,
    ],
    `CONFIGURATION Plant RESOURCE Cpu ON Cpu
TASK Fast (INTERVAL := T#10ms, PRIORITY := 1);
TASK Slow (INTERVAL := T#100ms, PRIORITY := 2);
PROGRAM F WITH Fast: Main; PROGRAM S WITH Slow: Main;
END_RESOURCE END_CONFIGURATION`,
  );
  const clock = new VirtualClock();
  let tick: (() => void) | undefined;
  let reads = 0,
    forceStages = 0;
  const runtime = createRuntime({
    clock,
    ticker: {
      start: (_ms, callback) => {
        tick = callback;
        return () => {
          tick = undefined;
        };
      },
    },
    stages: {
      readInputs: () => {
        if (++reads === 1) clock.advance(2);
        return Array<number>(64).fill(0);
      },
      applyForces: () => {
        if ([2, 6].includes(++forceStages)) clock.advance(1);
      },
    },
  });
  runtime.load(compiled);
  runtime.setBreakpoints([{ pou: "Main", line: 2 }]);
  runtime.run();
  clock.advance(10);
  tick!();
  expect(clock.now()).toBe(12);
  expect(runtime.state).toBe("HALT");
  clock.advance(5000);
  runtime.setBreakpoints([]);
  runtime.continue();
  expect(runtime.snapshot().tasks[0]).toMatchObject({
    runCount: 1,
    lastExecutionTimeMs: 3,
    overruns: 0,
  });
  expect(clock.now()).toBe(5013);
  expect(runtime.snapshot().lastExecutionTimeMs).toBe(3);
  clock.advance(5020 - clock.now());
  tick!();
  expect(runtime.snapshot().tasks[1]).toMatchObject({
    runCount: 1,
    lastExecutionTimeMs: 1,
    overruns: 0,
  });
  expect(clock.now()).toBe(5021);
  clock.advance(5090 - clock.now());
  tick!();
  expect(runtime.snapshot().tasks[1]?.runCount).toBe(1);
  clock.advance(5100 - clock.now());
  tick!();
  expect(runtime.snapshot().tasks[1]?.runCount).toBe(2);
  runtime.stop();
});

it("halts the entire resource through multiple tasks and retains each program's current statement", () => {
  const compiled = compile(
    [
      `PROGRAM Main VAR n: INT; END_VAR
n := n + 1;
END_PROGRAM`,
    ],
    `CONFIGURATION Plant RESOURCE Cpu ON Cpu
TASK Fast (INTERVAL := T#10ms, PRIORITY := 1);
TASK Slow (INTERVAL := T#100ms, PRIORITY := 2);
PROGRAM F WITH Fast: Main; PROGRAM S WITH Slow: Main;
END_RESOURCE END_CONFIGURATION`,
  );
  const { runtime, clock, value } = setup(compiled);
  runtime.run();
  clock.advance(90);
  runtime.setBreakpoints([{ pou: "Main", line: 2 }]);
  clock.advance(10);
  expect(runtime.halted).toMatchObject({ task: "Fast", frames: [{ instance: "F" }] });
  clock.advance(5001);
  expect(value("S.n")).toMatchObject({ value: 0 });
  runtime.continue();
  expect(runtime.halted).toMatchObject({ task: "Slow", frames: [{ instance: "S" }] });
  expect(value("F.n")).toMatchObject({ value: 10 });
  runtime.setBreakpoints([]);
  runtime.continue();
  expect(value("S.n")).toMatchObject({ value: 1 });
  expect(runtime.snapshot().tasks.map((task) => task.overruns)).toEqual([0, 0]);
  runtime.stop();
});

it("a halted write changes the branch taken without publishing an output until the run completes", () => {
  const compiled = compile([
    `PROGRAM Main VAR Level: INT; Q AT %QX0.0: BOOL; END_VAR
IF Level > 80 THEN Q := TRUE; END_IF;
END_PROGRAM`,
  ]);
  const { runtime, id, value } = setup(compiled);
  runtime.setBreakpoints([{ pou: "Main", line: 2 }]);
  runtime.run();
  runtime.scanOnce();
  runtime.write(id("mainInstance.Level"), { dataType: "INT", value: 90 });
  expect(value("mainInstance.Level")).toMatchObject({ value: 90 });
  expect(runtime.snapshot().outputs[0]).toBe(0);
  runtime.setBreakpoints([]);
  runtime.continue();
  expect(runtime.snapshot().outputs[0]).toBe(1);
  runtime.stop();
});

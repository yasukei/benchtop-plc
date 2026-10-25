import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable, type IoImage } from "@benchtop-plc/core";
import {
  createRuntime,
  standardLibrary,
  VirtualClock,
  VirtualTicker,
  type RuntimeOptions,
  type Ticker,
} from "@benchtop-plc/runtime";

const counter = "PROGRAM Counter VAR n : DINT; END_VAR n := n + 1; END_PROGRAM";
const cyclic = (name: string, interval: number, priority = 1) =>
  `TASK ${name} (INTERVAL := T#${interval}ms, PRIORITY := ${priority});`;
const instance = (name: string, task: string, type = "Counter") =>
  `PROGRAM ${name} WITH ${task} : ${type};`;
const config = (tasks: string, programs: string, globals = "") =>
  `CONFIGURATION Plant ${globals} RESOURCE Station ON Cpu ${tasks} ${programs} END_RESOURCE END_CONFIGURATION`;

class ManualTicker implements Ticker {
  interval = 0;
  tick = () => {};
  start(interval: number, tick: () => void) {
    this.interval = interval;
    this.tick = tick;
    return () => {
      this.tick = () => {};
    };
  }
}

function setup(source: string, pous = [counter], options: Partial<RuntimeOptions> = {}) {
  const result = compileProject(pous, [], source);
  expect(result.diagnostics).toEqual([]);
  const ir = structuredClone(result.ir!);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock), ...options });
  runtime.load(ir);
  const id = (name: string) => ir.variables.findIndex((v) => v.key === name.toUpperCase());
  const value = (name: string) => snapshotVariable(runtime.snapshot(), id(name));
  return { runtime, clock, ir, id, value };
}

it("traces 10/30 ms tasks at 3:1, with the highest priority first when both are due", () => {
  const { runtime, clock, value, id } = setup(
    config(
      cyclic("Slow", 30, 9) + cyclic("Fast", 10, 0),
      instance("S", "Slow", "SlowProgram") + instance("F", "Fast", "FastProgram"),
      "VAR_GLOBAL order : INT; END_VAR",
    ),
    [
      "PROGRAM SlowProgram VAR_EXTERNAL order : INT; END_VAR order := order * 10 + 2; END_PROGRAM",
      "PROGRAM FastProgram VAR_EXTERNAL order : INT; END_VAR order := order * 10 + 1; END_PROGRAM",
    ],
  );
  runtime.run();
  clock.advance(20);
  runtime.write(id("order"), { dataType: "INT", value: 0 });
  clock.advance(10);
  expect(value("order")).toMatchObject({ value: 12 });
  clock.advance(60);
  expect(runtime.snapshot().tasks).toMatchObject([{ runCount: 3 }, { runCount: 9 }]);
  expect(runtime.snapshot().scanCount).toBe(9);
});

it("uses the GCD tick and waits one full interval after RUN and STOP → RUN", () => {
  const ticker = new ManualTicker();
  const clock = new VirtualClock();
  const { runtime, value } = setup(
    config(cyclic("A", 20) + cyclic("B", 30), instance("P", "A") + instance("Q", "B")),
    [counter],
    { clock, ticker },
  );
  runtime.run();
  expect(ticker.interval).toBe(10);
  clock.advance(10);
  ticker.tick();
  expect(runtime.snapshot().scanCount).toBe(0);
  clock.advance(10);
  ticker.tick();
  expect(value("P.n")).toMatchObject({ value: 1 });
  runtime.stop();
  clock.advance(1000);
  runtime.run();
  clock.advance(10);
  ticker.tick();
  expect(value("Q.n")).toMatchObject({ value: 0 });
  clock.advance(10);
  ticker.tick();
  expect(value("P.n")).toMatchObject({ value: 2 });
  expect(runtime.snapshot().tasks.every((task) => task.overruns === 0)).toBe(true);
});

it("breaks equal priorities by longest wait, then task declaration order", () => {
  for (const late of [false, true]) {
    const ticker = new ManualTicker(),
      clock = new VirtualClock();
    const { runtime, value } = setup(
      config(
        cyclic("First", late ? 30 : 10) + cyclic("Second", 10),
        instance("B", "Second", "Append2") + instance("A", "First", "Append1"),
        "VAR_GLOBAL order : INT; END_VAR",
      ),
      [
        "PROGRAM Append1 VAR_EXTERNAL order : INT; END_VAR order := order * 10 + 1; END_PROGRAM",
        "PROGRAM Append2 VAR_EXTERNAL order : INT; END_VAR order := order * 10 + 2; END_PROGRAM",
      ],
      { clock, ticker },
    );
    runtime.run();
    clock.advance(late ? 30 : 10);
    ticker.tick();
    expect(value("order")).toMatchObject({ value: late ? 21 : 12 });
  }
});

it("samples rising edges on every pass and preserves the sample over STOP, including steps", () => {
  const inputs: IoImage = [false, false, false, false, false, false, false, false];
  const { runtime, clock, value } = setup(
    config("TASK Edge (SINGLE := %IX0.0, PRIORITY := 0);", instance("A", "Edge")),
    [counter],
    { stages: { readInputs: () => inputs } },
  );
  runtime.run();
  clock.advance(10);
  expect(runtime.snapshot().scanCount).toBe(0);
  runtime.stop();
  inputs[0] = true;
  clock.advance(100);
  runtime.step();
  expect(value("A.n")).toMatchObject({ value: 1 });
  runtime.step();
  runtime.run();
  clock.advance(20);
  expect(value("A.n")).toMatchObject({ value: 1 });
  inputs[0] = false;
  clock.advance(10);
  runtime.stop();
  inputs[0] = true;
  runtime.run();
  clock.advance(10);
  expect(value("A.n")).toMatchObject({ value: 2 });
  runtime.coldReset();
  runtime.run();
  clock.advance(10);
  expect(value("A.n")).toMatchObject({ value: 1 });
  expect(runtime.snapshot().tasks).toMatchObject([{ runCount: 1, overruns: 0 }]);
});

it("defers a global edge produced during a pass and samples inputs even when their task is not due", () => {
  const { runtime, clock, value } = setup(
    config(
      cyclic("WriterTask", 30) + cyclic("Poll", 10) + "TASK Edge (SINGLE := flag, PRIORITY := 0);",
      instance("A", "WriterTask", "Writer") + instance("B", "Edge"),
      "VAR_GLOBAL flag : BOOL; END_VAR",
    ),
    [counter, "PROGRAM Writer VAR_EXTERNAL flag : BOOL; END_VAR flag := TRUE; END_PROGRAM"],
  );
  runtime.run();
  clock.advance(30);
  expect(value("B.n")).toMatchObject({ value: 0 });
  clock.advance(10);
  expect(value("B.n")).toMatchObject({ value: 1 });
  clock.advance(50);
  expect(value("B.n")).toMatchObject({ value: 1 });
});

it("samples a located BOOL global from fresh inputs, and clears samples/statistics on load", () => {
  const inputs: IoImage = [false, true, false, false, false, false, false, false];
  const { runtime, clock, ir, value } = setup(
    config(
      "TASK Edge (SINGLE := flag, PRIORITY := 0);",
      instance("A", "Edge"),
      "VAR_GLOBAL flag AT %IX0.1 : BOOL; END_VAR",
    ),
    [counter],
    { stages: { readInputs: () => inputs } },
  );
  runtime.run();
  clock.advance(10);
  expect(value("A.n")).toMatchObject({ value: 1 });
  runtime.load(ir);
  expect(runtime.snapshot().tasks).toMatchObject([
    { runCount: 0, maxExecutionTimeMs: 0, overruns: 0 },
  ]);
  runtime.step();
  expect(value("A.n")).toMatchObject({ value: 1 });
});

it("steps every cyclic task once regardless of intervals and includes only rising event tasks", () => {
  const { runtime, value, id } = setup(
    config(
      cyclic("Fast", 10) + cyclic("Slow", 1000) + "TASK Edge (SINGLE := flag, PRIORITY := 0);",
      instance("F", "Fast") + instance("S", "Slow") + instance("E", "Edge"),
      "VAR_GLOBAL flag : BOOL := TRUE; END_VAR",
    ),
  );
  runtime.step();
  runtime.step();
  expect(value("F.n")).toMatchObject({ value: 2 });
  expect(value("S.n")).toMatchObject({ value: 2 });
  expect(value("E.n")).toMatchObject({ value: 1 });
  runtime.write(id("flag"), { dataType: "BOOL", value: false });
  runtime.step();
  runtime.write(id("flag"), { dataType: "BOOL", value: true });
  runtime.step();
  expect(value("E.n")).toMatchObject({ value: 2 });
  expect(runtime.snapshot().tasks.every((task) => task.overruns === 0)).toBe(true);
});

it("counts missed activations without catch-up or fault, and measures each task with the clock", () => {
  const clock = new VirtualClock(),
    ticker = new ManualTicker();
  let cost = 25;
  const { runtime, value } = setup(
    config(cyclic("Busy", 10), instance("A", "Busy", "Work")),
    ["PROGRAM Work VAR n : INT; END_VAR n := ABS(n + 1); END_PROGRAM"],
    {
      clock,
      ticker,
      library: {
        ...standardLibrary,
        callFunction(...args) {
          clock.advance(cost);
          return standardLibrary.callFunction(...args);
        },
      },
    },
  );
  runtime.run();
  clock.advance(10);
  ticker.tick();
  expect(clock.now()).toBe(35);
  expect(runtime.state).toBe("RUN");
  expect(runtime.snapshot().tasks).toEqual([
    { name: "Busy", runCount: 1, lastExecutionTimeMs: 25, maxExecutionTimeMs: 25, overruns: 2 },
  ]);
  cost = 0;
  clock.advance(4);
  ticker.tick();
  expect(value("A.n")).toMatchObject({ value: 1 });
  clock.advance(1);
  ticker.tick();
  expect(value("A.n")).toMatchObject({ value: 2 });
  expect(runtime.snapshot().tasks[0]).toMatchObject({
    runCount: 2,
    lastExecutionTimeMs: 0,
    maxExecutionTimeMs: 25,
    overruns: 2,
  });
  const copy = runtime.snapshot();
  copy.tasks[0]!.overruns = 999;
  expect(runtime.snapshot().tasks[0]!.overruns).toBe(2);
});

it("keeps tasks that become due during execution for the next pass", () => {
  const clock = new VirtualClock(),
    ticker = new ManualTicker();
  const { runtime, value } = setup(
    config(
      cyclic("Busy", 10) + cyclic("Later", 20),
      instance("A", "Busy", "Work") + instance("B", "Later"),
    ),
    [counter, "PROGRAM Work VAR n : INT; END_VAR n := ABS(n + 1); END_PROGRAM"],
    {
      clock,
      ticker,
      library: {
        ...standardLibrary,
        callFunction(...args) {
          clock.advance(25);
          return standardLibrary.callFunction(...args);
        },
      },
    },
  );
  runtime.run();
  clock.advance(10);
  ticker.tick();
  expect(value("B.n")).toMatchObject({ value: 0 });
  ticker.tick();
  expect(value("B.n")).toMatchObject({ value: 1 });
  expect(runtime.snapshot().tasks[1]).toMatchObject({ runCount: 1, overruns: 0 });
});

it("refreshes and publishes images per task, consuming pending writes in the first ready task", () => {
  let reads = 0;
  const published: boolean[] = [];
  const { runtime, clock, id, value } = setup(
    config(
      cyclic("First", 10, 0) + cyclic("Second", 10, 1),
      "PROGRAM A WITH First : Copy (signal := %IX0.0, lamp => %QX0.0); PROGRAM B WITH Second : Copy (signal := %IX0.0, lamp => %QX0.0);",
      "VAR_GLOBAL g : INT; END_VAR",
    ),
    [
      "PROGRAM Copy VAR_INPUT signal : BOOL; END_VAR VAR_OUTPUT lamp : BOOL; END_VAR VAR_EXTERNAL g : INT; END_VAR g := g + 1; lamp := signal; END_PROGRAM",
    ],
    {
      stages: {
        readInputs: () => [++reads === 1, false, false, false, false, false, false, false],
        writeOutputs: (image) => {
          published.push(image[0]);
        },
      },
    },
  );
  runtime.run();
  runtime.write(id("g"), { dataType: "INT", value: 10 });
  clock.advance(10);
  expect(published.slice(-2)).toEqual([true, false]);
  expect(value("g")).toMatchObject({ value: 12 });
  runtime.force(id("A.lamp"), { dataType: "BOOL", value: true });
  clock.advance(10);
  expect(published.slice(-2)).toEqual([true, false]);
});

it("gives each task its own loop budget and faults all tasks with the offending task's name", () => {
  const { runtime, clock } = setup(
    config(
      cyclic("First", 10) + cyclic("Second", 10),
      instance("A", "First", "Loop") + instance("B", "Second", "Loop"),
    ),
    ["PROGRAM Loop VAR n : DINT; END_VAR FOR n := 1 TO 100001 DO END_FOR; END_PROGRAM"],
  );
  runtime.step();
  expect(runtime.state).toBe("STOP");
  expect(runtime.snapshot().tasks.map((task) => task.runCount)).toEqual([1, 1]);
  runtime.run();
  clock.advance(10);
  runtime.setEmergencyStop(true);
  clock.advance(100);
  expect(runtime.snapshot().tasks.map((task) => task.runCount)).toEqual([2, 2]);
  runtime.step();
  expect(runtime.state).toBe("ESTOP");

  const faulty = setup(
    config(
      cyclic("Good", 10, 1) + cyclic("Bad", 10, 0),
      instance("A", "Bad", "Fail") + instance("B", "Good"),
    ),
    [counter, "PROGRAM Fail VAR n, zero : INT; END_VAR n := 1 / zero; END_PROGRAM"],
  );
  faulty.runtime.run();
  faulty.clock.advance(10);
  expect(faulty.runtime.state).toBe("FAULT");
  expect(faulty.runtime.diagnostic).toMatchObject({
    code: "runtime.division-by-zero",
    task: "Bad",
    instance: "A",
    pou: "Fail",
  });
  expect(faulty.value("B.n")).toMatchObject({ value: 0 });
  faulty.clock.advance(100);
  expect(faulty.runtime.snapshot().tasks.map((task) => task.runCount)).toEqual([0, 1]);
});

it("retains slow and event PROGRAM annotations between runs of their first instances", () => {
  const inputs: IoImage = [false, false, false, false, false, false, false, false];
  const { runtime, clock, ir } = setup(
    config(
      cyclic("Fast", 10) + cyclic("Slow", 30) + "TASK Edge (SINGLE := %IX0.0, PRIORITY := 0);",
      instance("First", "Slow") +
        instance("Later", "Fast") +
        instance("OnEdge", "Edge", "EventProgram"),
    ),
    [counter, "PROGRAM EventProgram VAR n : DINT; END_VAR n := n + 1; END_PROGRAM"],
    { stages: { readInputs: () => inputs } },
  );
  runtime.run();
  clock.advance(10);
  expect(runtime.snapshot().annotations).toEqual({});
  clock.advance(20);
  const slow = runtime.snapshot().annotations.Counter;
  expect(Object.values(slow!).flat()[0]!.values).toEqual([{ dataType: "DINT", value: 1 }]);
  inputs[0] = true;
  clock.advance(10);
  const edge = runtime.snapshot().annotations.EventProgram;
  expect(Object.values(edge!).flat()[0]!.values).toEqual([{ dataType: "DINT", value: 1 }]);
  expect(runtime.snapshot().annotations.Counter).toEqual(slow);
  clock.advance(10);
  expect(runtime.snapshot().annotations).toEqual({ Counter: slow, EventProgram: edge });
  clock.advance(10);
  expect(Object.values(runtime.snapshot().annotations.Counter!).flat()[0]!.values).toEqual([
    { dataType: "DINT", value: 2 },
  ]);
  expect(runtime.snapshot().annotations.EventProgram).toEqual(edge);
  runtime.coldReset();
  expect(runtime.snapshot().annotations).toEqual({});
  runtime.step();
  expect(Object.keys(runtime.snapshot().annotations)).toEqual(["EventProgram", "Counter"]);
  runtime.load(ir);
  expect(runtime.snapshot().annotations).toEqual({});
});

it("removes a POU's old annotations when its annotating instance runs no statements", () => {
  const { runtime, clock } = setup(
    config(
      cyclic("Fast", 10) + cyclic("Slow", 30),
      instance("A", "Fast") + instance("B", "Slow", "Conditional"),
    ),
    [
      counter,
      "PROGRAM Conditional VAR n : DINT; END_VAR IF n = 0 THEN n := 1; END_IF; END_PROGRAM",
    ],
  );
  runtime.run();
  clock.advance(30);
  expect(runtime.snapshot().annotations.Conditional).toBeDefined();
  clock.advance(20);
  expect(runtime.snapshot().annotations.Conditional).toBeDefined();
  clock.advance(10);
  expect(runtime.snapshot().annotations.Conditional).toBeUndefined();
  expect(Object.values(runtime.snapshot().annotations.Counter!).flat()[0]!.values).toEqual([
    { dataType: "DINT", value: 6 },
  ]);
});

it("replaces a faulting POU's prior annotations with only its completed statements", () => {
  const { runtime, clock, id } = setup(
    config(
      cyclic("Fast", 10) + cyclic("Slow", 30),
      instance("A", "Fast") + instance("B", "Slow", "FaultProgram"),
      "VAR_GLOBAL crash : BOOL; END_VAR",
    ),
    [
      counter,
      `PROGRAM FaultProgram VAR_EXTERNAL crash : BOOL; END_VAR
VAR completed, oldValue, result, zero : DINT; END_VAR
completed := completed + 1;
IF crash THEN result := 1 / zero; ELSE oldValue := oldValue + 1; END_IF;
END_PROGRAM`,
    ],
  );
  runtime.run();
  clock.advance(30);
  expect(Object.values(runtime.snapshot().annotations.FaultProgram!).flat()).toHaveLength(2);
  runtime.write(id("crash"), { dataType: "BOOL", value: true });
  clock.advance(30);
  expect(runtime.state).toBe("FAULT");
  expect(
    Object.values(runtime.snapshot().annotations.FaultProgram!)
      .flat()
      .map((entry) => entry.values),
  ).toEqual([[{ dataType: "DINT", value: 2 }]]);
  expect(Object.values(runtime.snapshot().annotations.Counter!).flat()[0]!.values).toEqual([
    { dataType: "DINT", value: 6 },
  ]);
});

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable } from "@benchtop-plc/core";
import { readProject } from "@benchtop-plc/project";
import {
  createRuntime,
  VirtualClock,
  VirtualTicker,
  type RuntimeOptions,
  type PauseLocation,
} from "@benchtop-plc/runtime";

function compile(sources: string[], configuration?: string) {
  const result = compileProject(sources, [], configuration);
  expect(result.diagnostics).toEqual([]);
  return result.ir!;
}
type IR = ReturnType<typeof compile>;
function setup(ir: IR, options: Partial<RuntimeOptions> = {}) {
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock), ...options });
  runtime.load(ir);
  runtime.watch(ir.variables.map((_, id) => id));
  const id = (name: string) =>
    ir.variables.findIndex((v) => v.key === `MAININSTANCE.${name.toUpperCase()}`);
  const value = (name: string) => snapshotVariable(runtime.snapshot(), id(name));
  return { runtime, clock, id, value };
}

it.each([
  "blink",
  "running-light",
  "motor-starters",
  "batch-mixer",
  "tank-station",
  "sorting-conveyor",
])(
  "%s has identical variables, outputs, annotations and telemetry after a pause at each statement",
  (name) => {
    const project = readProject(
      readFileSync(new URL(`../../examples/${name}/project.xml`, import.meta.url), "utf8"),
    ).value!;
    const compiled = compileProject(project.pous, project.dataTypes, project.configurationSource);
    expect(compiled.diagnostics).toEqual([]);
    const ir = compiled.ir!;
    const locations: PauseLocation[] = [];
    const baseline = setup(ir, {
      pause: (location) => {
        locations.push(location);
        return false;
      },
    }).runtime;
    baseline.run();
    const expected = baseline.scanOnce();
    expect(locations.length).toBeGreaterThan(0);
    for (let target = 0; target < locations.length; target++) {
      let seen = 0;
      const { runtime } = setup(ir, { pause: () => seen++ === target });
      runtime.run();
      const paused = runtime.scanOnce();
      expect(runtime.pauseLocation).toEqual(locations[target]);
      expect(ir.resource.tasks.some((task) => task.name === runtime.pauseLocation!.task)).toBe(
        true,
      );
      expect(paused.scanCount).toBe(0);
      expect(paused.outputs.every((byte) => byte === 0)).toBe(true);
      expect(runtime.scanOnce()).toEqual(paused);
      expect(runtime.resume(), `${name}, statement ${target}`).toEqual(expected);
      expect(runtime.pauseLocation).toBeNull();
    }
    // Also suspend every boundary of the same run, including repeated loop bodies.
    const all = setup(ir, { pause: () => true }).runtime;
    all.run();
    all.scanOnce();
    let count = 0;
    while (all.pauseLocation) {
      count++;
      expect(count).toBeLessThanOrEqual(locations.length);
      all.resume();
    }
    expect(count).toBe(locations.length);
    expect(all.snapshot()).toEqual(expected);
  },
);

const nested = compile([
  `PROGRAM Main VAR inherited: Empty; direct: Derived; c: Child; face: IValue; r: REF_TO Base;
    i: INT; total: INT; resultValue: INT; END_VAR
    inherited(); direct(); face := c; r := REF(direct);
    FOR i := 1 TO 3 DO total := total + Twice(i) + face.Value() + r^.Value(); END_FOR;
    resultValue := c.Entry();
  END_PROGRAM`,
  `FUNCTION Twice : INT VAR_INPUT x: INT; END_VAR VAR local: INT; END_VAR
    local := x + 1; Twice := local * 2; END_FUNCTION`,
  `FUNCTION_BLOCK Base VAR_OUTPUT Count: INT; END_VAR
    METHOD PUBLIC Value : INT Value := Count; END_METHOD
    Count := Count + 1;
  END_FUNCTION_BLOCK`,
  `FUNCTION_BLOCK Empty EXTENDS Base END_FUNCTION_BLOCK`,
  `FUNCTION_BLOCK Derived EXTENDS Base SUPER(); Count := Count + 10; END_FUNCTION_BLOCK`,
  `INTERFACE IValue METHOD Value : INT END_METHOD END_INTERFACE`,
  `CLASS Parent IMPLEMENTS IValue VAR n: INT := 2; END_VAR
    METHOD PUBLIC Value : INT VAR local: INT; END_VAR local := n + 1; Value := local; END_METHOD
    METHOD PUBLIC Entry : INT Entry := THIS.Value(); END_METHOD
  END_CLASS`,
  `CLASS Child EXTENDS Parent
    METHOD PUBLIC OVERRIDE Value : INT Value := SUPER.Value() + 4; END_METHOD
  END_CLASS`,
]);

it("preserves expression operands, call locals and receiver paths at every nested boundary", () => {
  const baseline = setup(nested).runtime;
  const expected = baseline.scanOnce();
  expect(baseline.diagnostic).toBeNull();
  const locations: PauseLocation[] = [];
  const { runtime, value } = setup(nested, {
    pause: (location) => {
      locations.push(location);
      return true;
    },
  });
  runtime.scanOnce();
  while (runtime.pauseLocation) runtime.resume();
  expect(runtime.snapshot()).toEqual(expected);
  expect(value("total")).toMatchObject({ value: 4 + 6 + 8 + 3 * (7 + 11) });
  expect(value("resultValue")).toMatchObject({ value: 7 });
  expect(locations).toContainEqual(
    expect.objectContaining({ pou: "Base", instancePath: "mainInstance.INHERITED" }),
  );
  expect(locations).toContainEqual(
    expect.objectContaining({ pou: "Base", instancePath: "mainInstance.DIRECT" }),
  );
  expect(locations).toContainEqual(expect.objectContaining({ pou: "Twice", instancePath: null }));
  expect(locations).toContainEqual(
    expect.objectContaining({ pou: "Parent.Value", instancePath: "mainInstance.C" }),
  );
  expect(locations.filter((location) => location.pou === "Twice")).toHaveLength(6);
});

it.each(["stop", "warmRestart", "coldReset", "load", "emergencyStop"] as const)(
  "%s abandons a nested invocation without copying outputs or executing its remaining statements",
  (command) => {
    const ir = compile([
      `PROGRAM Main VAR b: Block; outputValue: INT; END_VAR b(Q => outputValue); END_PROGRAM`,
      `FUNCTION_BLOCK Block VAR_OUTPUT Q: INT; END_VAR VAR RETAIN count: INT; END_VAR
       count := count + 1; Q := 7; count := count + 100; END_FUNCTION_BLOCK`,
    ]);
    let enabled = true;
    const { runtime, value } = setup(ir, {
      pause: (location) =>
        enabled &&
        location.pou === "Block" &&
        location.span.line === 2 &&
        location.span.column > 30,
    });
    runtime.scanOnce();
    expect(runtime.pauseLocation?.pou).toBe("Block");
    expect(value("b.count")).toMatchObject({ value: 1 });
    if (command === "load") runtime.load(ir);
    else if (command === "emergencyStop") runtime.setEmergencyStop(true);
    else runtime[command]();
    expect(runtime.pauseLocation).toBeNull();
    expect(value("outputValue")).toMatchObject({ value: 0 });
    expect(value("b.count")).toMatchObject({
      value: command === "coldReset" || command === "load" ? 0 : 1,
    });
    const after = runtime.snapshot();
    expect(runtime.resume()).toEqual(after);
    if (command === "emergencyStop") runtime.setEmergencyStop(false);
    enabled = false;
    runtime.scanOnce();
    expect(runtime.diagnostic).toBeNull();
    expect(value("outputValue")).toMatchObject({ value: 7 });
  },
);

it("keeps the watchdog budget across pauses and faults with the original location", () => {
  const ir = compile([
    `PROGRAM Main VAR i, n: DINT; END_VAR FOR i := 1 TO 200001 DO n := n + 1; END_FOR; END_PROGRAM`,
  ]);
  let visits = 0;
  const { runtime, value } = setup(ir, { pause: () => ++visits === 100002 });
  runtime.scanOnce();
  expect(runtime.pauseLocation).not.toBeNull();
  runtime.resume();
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.watchdog",
    pou: "Main",
    args: { limit: 200000 },
  });
  expect(value("n")).toMatchObject({ value: 200000 });
}, 30000);

it("reports each task and keeps task telemetry unchanged when the clock does not advance", () => {
  const ir = compile(
    [`PROGRAM Main VAR n: INT; END_VAR n := n + 1; n := n + 1; END_PROGRAM`],
    `CONFIGURATION Plant RESOURCE Cpu ON Cpu
      TASK Fast (INTERVAL := T#10ms, PRIORITY := 1);
      TASK Slow (INTERVAL := T#100ms, PRIORITY := 2);
      PROGRAM F WITH Fast: Main; PROGRAM S WITH Slow: Main;
    END_RESOURCE END_CONFIGURATION`,
  );
  const baseline = setup(ir).runtime.scanOnce();
  const locations: PauseLocation[] = [];
  const { runtime } = setup(ir, {
    pause: (location) => {
      locations.push(location);
      return true;
    },
  });
  runtime.scanOnce();
  while (runtime.pauseLocation) runtime.resume();
  expect(runtime.snapshot()).toEqual(baseline);
  expect(locations.map(({ task, instancePath }) => ({ task, instancePath }))).toEqual([
    { task: "Fast", instancePath: "F" },
    { task: "Fast", instancePath: "F" },
    { task: "Slow", instancePath: "S" },
    { task: "Slow", instancePath: "S" },
  ]);
});

it("evaluates arguments and output targets once, in order, across pauses", () => {
  const ir = compile([
    `PROGRAM Main VAR n: INT := 1; a: ARRAY[1..4] OF INT; total, seen: INT; END_VAR
      total := Combine(first := n, second := Change(n := n), Q => a[Change(n := n)]);
      seen := total;
    END_PROGRAM`,
    `FUNCTION Change : INT VAR_IN_OUT n: INT; END_VAR n := n + 1; Change := n; END_FUNCTION`,
    `FUNCTION Combine : INT VAR_INPUT first, second: INT; END_VAR VAR_OUTPUT Q: INT; END_VAR
      Q := first * 10 + second; Combine := Q; END_FUNCTION`,
  ]);
  const { runtime, value } = setup(ir, { pause: () => true });
  runtime.scanOnce();
  while (runtime.pauseLocation) runtime.resume();
  expect(runtime.diagnostic).toBeNull();
  expect(value("total")).toMatchObject({ value: 12 });
  expect(value("seen")).toMatchObject({ value: 12 });
  expect(value("n")).toMatchObject({ value: 3 });
  expect(value("a[3]")).toMatchObject({ value: 12 });
});

it("evaluates calls in assignment and standard/user-block output targets after the value", () => {
  const ir = compile([
    `PROGRAM Main VAR n: INT; a: ARRAY[1..8] OF INT; b: Block; timer: TON; times: ARRAY[1..8] OF TIME; END_VAR
      a[Next(n := n)] := Next(n := n);
      b(Q => a[Next(n := n)]);
      timer(IN := TRUE, PT := T#0ms, ET => times[Next(n := n)]);
    END_PROGRAM`,
    `FUNCTION Next : INT VAR_IN_OUT n: INT; END_VAR n := n + 1; Next := n; END_FUNCTION`,
    `FUNCTION_BLOCK Block VAR_OUTPUT Q: INT; END_VAR Q := 7; END_FUNCTION_BLOCK`,
  ]);
  const { runtime, value } = setup(ir, { pause: () => true });
  runtime.scanOnce();
  while (runtime.pauseLocation) runtime.resume();
  expect(runtime.diagnostic).toBeNull();
  expect(value("n")).toMatchObject({ value: 4 });
  expect(value("a[2]")).toMatchObject({ value: 1 });
  expect(value("a[3]")).toMatchObject({ value: 7 });
});

it("re-evaluates loop conditions and preserves EXIT and RETURN across pauses", () => {
  const ir = compile([
    `PROGRAM Main VAR n, total: INT; END_VAR
      WHILE Advance(n := n) < 3 DO total := total + n; END_WHILE;
      REPEAT total := total + 10; IF Advance(n := n) = 5 THEN EXIT; END_IF; UNTIL FALSE END_REPEAT;
      total := total + Early();
    END_PROGRAM`,
    `FUNCTION Advance : INT VAR_IN_OUT n: INT; END_VAR n := n + 1; Advance := n; END_FUNCTION`,
    `FUNCTION Early : INT Early := 100; RETURN; Early := 999; END_FUNCTION`,
  ]);
  const { runtime, value } = setup(ir, { pause: () => true });
  runtime.scanOnce();
  let halts = 0;
  while (runtime.pauseLocation) {
    expect(++halts).toBeLessThan(100);
    runtime.resume();
  }
  expect(runtime.diagnostic).toBeNull();
  expect(value("n")).toMatchObject({ value: 5 });
  expect(value("total")).toMatchObject({ value: 123 });
});

it("keeps the write and force stages identical across zero-time pauses", () => {
  const ir = compile([`PROGRAM Main VAR n, seen: INT; END_VAR n := n + 1; seen := n; END_PROGRAM`]);
  const run = (pause: boolean) => {
    const stages: string[] = [];
    const { runtime, clock, id } = setup(ir, {
      pause: () => pause,
      stages: {
        applyPendingWrites: () => stages.push("writes"),
        applyForces: () => stages.push("forces"),
        writeOutputs: () => stages.push("outputs"),
      },
    });
    runtime.force(id("n"), { dataType: "INT", value: 10 });
    runtime.run();
    runtime.write(id("seen"), { dataType: "INT", value: 99 });
    runtime.scanOnce();
    while (runtime.pauseLocation) runtime.resume();
    expect(clock.now()).toBe(0);
    return { snapshot: runtime.snapshot(), stages };
  };
  expect(run(true)).toEqual(run(false));
});

it("stop preserves forces and queued writes when abandoning a partially executed task", () => {
  const ir = compile([
    `PROGRAM Main VAR count, pending, forced, seen: INT; END_VAR
    count := count + 1;
    seen := pending + forced;
  END_PROGRAM`,
  ]);
  let enabled = true;
  const { runtime, id, value } = setup(ir, {
    pause: (location) => enabled && location.span.line === 3,
  });
  runtime.force(id("forced"), { dataType: "INT", value: 3 });
  runtime.run();
  runtime.scanOnce();
  expect(runtime.pauseLocation).not.toBeNull();
  expect(value("count")).toMatchObject({ value: 1 });
  runtime.write(id("pending"), { dataType: "INT", value: 99 });
  runtime.stop();
  expect(value("seen")).toMatchObject({ value: 0 });
  expect(runtime.snapshot().forced).toContain(id("forced"));
  enabled = false;
  runtime.run();
  runtime.scanOnce();
  expect(value("count")).toMatchObject({ value: 2 });
  expect(value("seen")).toMatchObject({ value: 102 });
});

it("preserves the fault and partial results when a resumed function faults", () => {
  const ir = compile([
    `PROGRAM Main VAR x: INT; END_VAR x := Divide(); END_PROGRAM`,
    `FUNCTION Divide : INT VAR zero: INT; END_VAR
      Divide := 2;
      Divide := 1 / zero;
    END_FUNCTION`,
  ]);
  const baseline = setup(ir).runtime;
  baseline.scanOnce();
  const { runtime } = setup(ir, {
    pause: (location) => location.pou === "Divide" && location.span.line === 3,
  });
  runtime.scanOnce();
  expect(runtime.state).toBe("STOP");
  runtime.resume();
  expect(runtime.state).toBe("FAULT");
  expect(runtime.pauseLocation).toBeNull();
  expect(runtime.snapshot()).toEqual(baseline.snapshot());
  expect(runtime.diagnostic).toEqual(baseline.diagnostic);
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.division-by-zero",
    pou: "Divide",
    span: { line: 3 },
  });
});

it.each(["Twice", "Parent.Value", "Base", "Main"])(
  "stop discards a suspended %s frame and the next scan starts from the first instance",
  (pou) => {
    let enabled = true;
    const { runtime, value } = setup(nested, {
      pause: (location) => enabled && location.pou === pou,
    });
    runtime.scanOnce();
    expect(runtime.pauseLocation?.pou).toBe(pou);
    runtime.stop();
    const abandoned = runtime.snapshot();
    expect(runtime.resume()).toEqual(abandoned);
    expect(runtime.pauseLocation).toBeNull();
    enabled = false;
    runtime.scanOnce();
    expect(runtime.diagnostic).toBeNull();
    expect(value("resultValue")).toMatchObject({ value: 7 });
    expect(value("i")).toMatchObject({ value: 4 });
  },
);

it("keeps a standard function's expression span when its resumed argument is invalid", () => {
  const ir = compile([
    `PROGRAM Main VAR x: INT; END_VAR x := 1 + STRING_TO_INT(Text()); END_PROGRAM`,
    `FUNCTION Text : STRING Text := 'invalid'; END_FUNCTION`,
  ]);
  const body = ir.programs[0]!.body;
  const assignment = body[0]!;
  if (assignment.kind !== "assignment" || assignment.value.kind !== "binary")
    throw new Error("Expected assignment");
  const { runtime } = setup(ir, { pause: () => true });
  runtime.scanOnce();
  while (runtime.pauseLocation) runtime.resume();
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.invalid-value",
    span: assignment.value.right.span,
  });
});

it("visits compound statements once and loop-body statements on each iteration", () => {
  const ir = compile([
    `PROGRAM Main VAR i, n: INT; END_VAR
    FOR i := 1 TO 2 DO n := n + 1; END_FOR;
    WHILE n < 4 DO n := n + 1; END_WHILE;
    REPEAT n := n + 1; UNTIL n >= 6 END_REPEAT;
    IF FALSE THEN n := 99; END_IF;
    CASE n OF 6: n := n + 1; ELSE n := 99; END_CASE;
  END_PROGRAM`,
  ]);
  const locations: PauseLocation[] = [];
  const { runtime, value } = setup(ir, {
    pause: (location) => {
      locations.push(location);
      return true;
    },
  });
  runtime.scanOnce();
  while (runtime.pauseLocation) runtime.resume();
  expect(value("n")).toMatchObject({ value: 7 });
  expect(locations).toHaveLength(12);
  for (const statement of ir.programs[0]!.body) {
    expect(
      locations.filter(
        (location) =>
          location.span.line === statement.span.line &&
          location.span.column === statement.span.column,
      ),
    ).toHaveLength(1);
  }
});

it("abandoning a later instance restarts the next task run from its first instance", () => {
  const ir = compile(
    [
      `PROGRAM Main VAR n, seen: INT; END_VAR
      n := n + 1;
      seen := n;
    END_PROGRAM`,
    ],
    `CONFIGURATION Plant RESOURCE Cpu ON Cpu
    TASK Cyclic (INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM First WITH Cyclic: Main; PROGRAM Second WITH Cyclic: Main;
  END_RESOURCE END_CONFIGURATION`,
  );
  let enabled = true;
  const { runtime } = setup(ir, {
    pause: (location) => enabled && location.instancePath === "Second" && location.span.line === 3,
  });
  const value = (path: string) =>
    snapshotVariable(
      runtime.snapshot(),
      ir.variables.findIndex((variable) => variable.key === path.toUpperCase()),
    );
  runtime.scanOnce();
  expect(value("First.seen")).toMatchObject({ value: 1 });
  expect(value("Second.n")).toMatchObject({ value: 1 });
  expect(value("Second.seen")).toMatchObject({ value: 0 });
  runtime.stop();
  enabled = false;
  runtime.scanOnce();
  expect(value("First.seen")).toMatchObject({ value: 2 });
  expect(value("Second.seen")).toMatchObject({ value: 2 });
});

it.each([false, true])(
  "captures each block output before its target changes the block (pause: %s)",
  (pause) => {
    const ir = compile([
      `PROGRAM Main VAR b: Block; a: ARRAY[1..2] OF INT; END_VAR
      b(Q => a[b.Index()], R => a[b.Index()]);
    END_PROGRAM`,
      `FUNCTION_BLOCK Block VAR_OUTPUT Q, R: INT; END_VAR VAR indexValue: INT; END_VAR
      METHOD PUBLIC Index : INT
        Q := Q + 1; R := R + 1; indexValue := indexValue + 1; Index := indexValue;
      END_METHOD
      Q := 7; R := 9;
    END_FUNCTION_BLOCK`,
    ]);
    const { runtime, value } = setup(ir, { pause: () => pause });
    runtime.scanOnce();
    while (runtime.pauseLocation) runtime.resume();
    expect(runtime.diagnostic).toBeNull();
    expect(value("a[1]")).toMatchObject({ value: 7 });
    expect(value("a[2]")).toMatchObject({ value: 10 });
    expect(value("b.Q")).toMatchObject({ value: 9 });
    expect(value("b.R")).toMatchObject({ value: 11 });
  },
);

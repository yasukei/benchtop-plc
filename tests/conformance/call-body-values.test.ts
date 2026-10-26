import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import type { AnnotatedBody, RuntimeSnapshot } from "@benchtop-plc/core";
import {
  createRuntime,
  VirtualClock,
  VirtualTicker,
  type RuntimeOptions,
} from "@benchtop-plc/runtime";

function setup(sources: string[], options: Partial<RuntimeOptions> = {}) {
  const result = compileProject(sources);
  expect(result.diagnostics).toEqual([]);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock), ...options });
  runtime.load(structuredClone(result.ir!));
  return runtime;
}
const body = (snapshot: RuntimeSnapshot, pou: string, instance: string | null) =>
  snapshot.annotations.find((body) => body.pou === pou && body.instance === instance);
const values = (body?: Pick<AnnotatedBody, "lines">) =>
  Object.values(body?.lines ?? {})
    .flat()
    .flatMap((entry) => entry.values);
const int = (value: number) => ({ dataType: "INT", value });
const counter = `FUNCTION_BLOCK Counter
VAR n: INT; END_VAR
METHOD PUBLIC Add: INT
VAR_INPUT amount: INT; END_VAR
VAR local: INT; END_VAR
local := amount + 1;
n := n + local;
Add := n;
END_METHOD
END_FUNCTION_BLOCK`;

it("records locals and results for each instance's last method call, retaining skipped methods", () => {
  const runtime = setup([
    `PROGRAM Main VAR a, b: Counter; first: BOOL := TRUE; END_VAR
IF first THEN a.Add(1); a.Add(2); first := FALSE; END_IF;
b.Add(7);
END_PROGRAM`,
    counter,
  ]);
  runtime.watchBodies([
    { pou: "Counter", instance: "mainInstance.A" },
    { pou: "Counter", instance: "mainInstance.B" },
  ]);
  const first = runtime.step();
  expect(values(body(first, "Counter.Add", "mainInstance.A"))).toEqual([int(3), int(5), int(5)]);
  expect(values(body(first, "Counter.Add", "mainInstance.B"))).toEqual([int(8), int(8), int(8)]);
  const second = runtime.step();
  expect(body(second, "Counter.Add", "mainInstance.A")).toEqual(
    body(first, "Counter.Add", "mainInstance.A"),
  );
  expect(body(second, "Counter.Add", "mainInstance.A")?.scanCount).toBe(1);
  expect(body(second, "Counter.Add", "mainInstance.B")?.scanCount).toBe(2);
  expect(values(body(second, "Counter.Add", "mainInstance.B"))).toEqual([int(8), int(16), int(16)]);
  runtime.watchBodies([]);
  expect(runtime.step().annotations).toEqual([]);
});

it.each(["face.Value()", "link^.Value()", "unit.Entry()"])(
  "annotates the actual override through %s",
  (call) => {
    const runtime = setup([
      `PROGRAM Main VAR unit: Derived; face: IValue; link: REF_TO Base; n: INT; END_VAR
face := unit; link := REF(unit); n := ${call}; END_PROGRAM`,
      `INTERFACE IValue METHOD Value: INT END_METHOD END_INTERFACE`,
      `CLASS Base IMPLEMENTS IValue
METHOD PUBLIC Value: INT Value := 1; END_METHOD
END_CLASS`,
      `CLASS Derived EXTENDS Base
METHOD PUBLIC OVERRIDE Value: INT Value := 7; END_METHOD
METHOD PUBLIC Entry: INT Entry := THIS.Value(); END_METHOD
END_CLASS`,
    ]);
    runtime.watchBodies([
      { pou: "Base", instance: "mainInstance.UNIT" },
      { pou: "Derived", instance: "mainInstance.UNIT" },
    ]);
    const snapshot = runtime.step();
    expect(values(body(snapshot, "Derived.Value", "mainInstance.UNIT"))).toEqual([int(7)]);
    expect(body(snapshot, "Base.Value", "mainInstance.UNIT")).toBeUndefined();
  },
);

it("records inherited and SUPER methods in the base source with the derived instance", () => {
  const runtime = setup([
    `PROGRAM Main VAR unit: Derived; n: INT; END_VAR n := unit.Inherited(); n := unit.Value(); END_PROGRAM`,
    `CLASS Base
METHOD PUBLIC Value: INT Value := 2; END_METHOD
METHOD PUBLIC Inherited: INT Inherited := 3; END_METHOD
END_CLASS`,
    `CLASS Derived EXTENDS Base
METHOD PUBLIC OVERRIDE Value: INT Value := SUPER.Value() + 5; END_METHOD
END_CLASS`,
  ]);
  runtime.watchBodies([
    { pou: "Base", instance: "mainInstance.UNIT" },
    { pou: "Derived", instance: "mainInstance.UNIT" },
  ]);
  const snapshot = runtime.step();
  expect(values(body(snapshot, "Base.Inherited", "mainInstance.UNIT"))).toEqual([int(3)]);
  expect(values(body(snapshot, "Base.Value", "mainInstance.UNIT"))).toEqual([int(2)]);
  expect(values(body(snapshot, "Derived.Value", "mainInstance.UNIT"))).toEqual([int(7)]);
});

it("shows the function's last call and its caller, preserving both across skipped passes and transport", () => {
  const runtime = setup([
    `PROGRAM Main VAR n: INT; first: BOOL := TRUE; END_VAR
IF first THEN
 n := Twice(1);
 n := Twice(5);
 first := FALSE;
END_IF;
END_PROGRAM`,
    `FUNCTION Twice: INT VAR_INPUT n: INT; END_VAR VAR local: INT; END_VAR
local := n + 1;
Twice := local * 2;
END_FUNCTION`,
  ]);
  runtime.watchBodies([{ pou: "Twice", instance: null }]);
  expect(runtime.snapshot().annotations).toEqual([]);
  const first = runtime.step();
  const call = body(first, "Twice", null)!;
  expect(values(call)).toEqual([int(6), int(12)]);
  expect(call.caller).toEqual({ pou: "Main", instance: "mainInstance", line: 4 });
  expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  expect(structuredClone(first)).toEqual(first);
  expect(body(runtime.step(), "Twice", null)).toEqual(call);
  call.caller!.pou = "mutated";
  expect(body(runtime.snapshot(), "Twice", null)?.caller?.pou).toBe("Main");
});

it("names immediate function, block and method callers with their call expression's line", () => {
  const runtime = setup([
    `PROGRAM Main VAR unit: Box; n: INT; END_VAR unit(); n := unit.Get(); END_PROGRAM`,
    `FUNCTION Leaf: INT Leaf := 9; END_FUNCTION`,
    `FUNCTION Outer: INT
Outer := Leaf();
END_FUNCTION`,
    `FUNCTION_BLOCK Box VAR n: INT; END_VAR
METHOD PUBLIC Get: INT
Get := Outer();
END_METHOD
n := Leaf();
END_FUNCTION_BLOCK`,
  ]);
  runtime.watchBodies([
    { pou: "Leaf", instance: null },
    { pou: "Outer", instance: null },
  ]);
  const snapshot = runtime.step();
  expect(body(snapshot, "Leaf", null)?.caller).toEqual({ pou: "Outer", instance: null, line: 2 });
  expect(body(snapshot, "Outer", null)?.caller).toEqual({
    pou: "Box.Get",
    instance: "mainInstance.UNIT",
    line: 3,
  });
});

it("clears each method invocation at entry and keeps completed values on a fault", () => {
  const runtime = setup([
    `PROGRAM Main VAR unit: Broken; END_VAR unit.Go(); END_PROGRAM`,
    `CLASS Broken VAR n, zero: INT; END_VAR
METHOD PUBLIC Go
n := n + 1;
IF n = 1 THEN zero := 0; ELSE zero := 1 / zero; END_IF;
END_METHOD END_CLASS`,
  ]);
  runtime.watchBodies([{ pou: "Broken", instance: "mainInstance.UNIT" }]);
  expect(values(body(runtime.step(), "Broken.Go", "mainInstance.UNIT"))).toEqual([int(1), int(0)]);
  const snapshot = runtime.step();
  expect(runtime.state).toBe("FAULT");
  expect(values(body(snapshot, "Broken.Go", "mainInstance.UNIT"))).toEqual([int(2)]);
  expect(body(snapshot, "Broken.Go", "mainInstance.UNIT")?.scanCount).toBe(2);
});

it("records every unwatched invocation while debugging, switching only at task boundaries", () => {
  let debugging = false;
  const runtime = setup(
    [
      `PROGRAM Main VAR unit: Counter; n: INT; END_VAR n := unit.Add(2); n := 0; END_PROGRAM`,
      counter,
    ],
    { debuggingActive: () => debugging, pause: () => true },
  );
  runtime.watchBodies([]);
  runtime.step();
  debugging = true;
  while (runtime.pauseLocation) {
    expect(runtime.frameAnnotations).toEqual([]);
    runtime.resume();
  }
  runtime.step();
  debugging = false;
  let recorded = false;
  while (runtime.pauseLocation) {
    const frames = runtime.frameAnnotations;
    expect(frames.length).toBeGreaterThan(0);
    if (frames.length === 2 && values(frames[1]).length === 2) {
      expect(frames.map((frame) => frame.pou)).toEqual(["Main", "Counter.Add"]);
      expect(values(frames[1])).toEqual([int(3), int(6)]);
      expect(frames[1]?.scanCount).toBe(2);
      frames[1]!.lines = {};
      expect(values(runtime.frameAnnotations[1])).toEqual([int(3), int(6)]);
      recorded = true;
    }
    runtime.resume();
  }
  expect(recorded).toBe(true);
  expect(runtime.snapshot().annotations).toEqual([]);
  runtime.step();
  expect(runtime.frameAnnotations).toEqual([]);
  runtime.stop();
});

it("reports a caller even when a function completes no scalar statements", () => {
  const runtime = setup([`PROGRAM Main Empty(); END_PROGRAM`, `FUNCTION Empty END_FUNCTION`]);
  runtime.watchBodies([{ pou: "Empty", instance: null }]);
  expect(body(runtime.step(), "Empty", null)).toEqual({
    pou: "Empty",
    instance: null,
    scanCount: 1,
    lines: {},
    caller: { pou: "Main", instance: "mainInstance", line: 1 },
  });
});

it("records unwatched PROGRAM, block and function frames separately while debugging", () => {
  const runtime = setup(
    [
      `PROGRAM Main VAR unit: Box; END_VAR unit(); END_PROGRAM`,
      `FUNCTION_BLOCK Box VAR n: INT; END_VAR n := 2; n := Twice(n); END_FUNCTION_BLOCK`,
      `FUNCTION Twice: INT VAR_INPUT n: INT; END_VAR VAR local: INT; END_VAR
local := n * 2;
Twice := local;
END_FUNCTION`,
    ],
    { debuggingActive: () => true, pause: () => true },
  );
  runtime.watchBodies([]);
  runtime.step();
  let seen = false;
  while (runtime.pauseLocation) {
    const frames = runtime.frameAnnotations;
    if (frames.length === 3 && values(frames[2]).length) {
      expect(frames.map((frame) => frame.pou)).toEqual(["Main", "Box", "Twice"]);
      expect(values(frames[0])).toEqual([]);
      expect(values(frames[1])).toEqual([int(2)]);
      expect(values(frames[2])).toEqual([int(4)]);
      expect(frames[2]?.instance).toBeNull();
      expect(frames[2]?.caller).toEqual({ pou: "Box", instance: "mainInstance.UNIT", line: 1 });
      seen = true;
    }
    runtime.resume();
  }
  expect(seen).toBe(true);
  expect(runtime.frameAnnotations).toEqual([]);
  expect(runtime.snapshot().annotations).toEqual([]);
});

import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

const motor = `FUNCTION_BLOCK Motor IMPLEMENTS IDrive
VAR_INPUT step: INT; END_VAR VAR_OUTPUT count: INT; END_VAR
METHOD PUBLIC Start count := count + 1; END_METHOD
METHOD PUBLIC Value : INT Value := count; END_METHOD
METHOD PUBLIC Identity : REF_TO Motor Identity := REF(THIS); END_METHOD
count := count + step;
END_FUNCTION_BLOCK`;
const servo = `FUNCTION_BLOCK ServoMotor EXTENDS Motor
VAR extra: INT := 10; END_VAR
METHOD PUBLIC OVERRIDE Start count := count + extra; END_METHOD
count := count + step * 2;
END_FUNCTION_BLOCK`;
const face = "INTERFACE IDrive METHOD Start END_METHOD METHOD Value : INT END_METHOD END_INTERFACE";
function setup(body: string, declarations = "", extra: string[] = []) {
  const compiled = compileProject([
    `PROGRAM Main VAR m: Motor; s: ServoMotor; devices: ARRAY[1..2] OF ServoMotor;
      r: REF_TO Motor; d: REF_TO ServoMotor; a: IDrive; first, second: INT; matched: BOOL;
      ${declarations} END_VAR ${body} END_PROGRAM`,
    motor,
    servo,
    face,
    ...extra,
  ]);
  expect(compiled.diagnostics).toEqual([]);
  const ir = structuredClone(compiled.ir!);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  runtime.watch(ir.variables.map((_, id) => id));
  const id = (name: string) =>
    ir.variables.findIndex((v) => v.key === `MAININSTANCE.${name.toUpperCase()}`);
  const value = (name: string) => snapshotVariable(runtime.snapshot(), id(name));
  return { runtime, ir, value, id };
}

it("passes REF_TO Motor into a function and dispatches Start on ServoMotor", () => {
  const { runtime, value } = setup(
    "first := StartMotor(REF(s)); r := s.Identity(); second := r^.Value();",
    "",
    [
      `FUNCTION StartMotor : INT VAR_INPUT device: REF_TO Motor; END_VAR
      device^.Start(); StartMotor := device^.Value(); END_FUNCTION`,
    ],
  );
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("first")).toMatchObject({ value: 10 });
  expect(value("second")).toMatchObject({ value: 10 });
  expect(value("r")).toEqual({ kind: "reference", target: "mainInstance.S" });
  runtime.step();
  expect(value("first")).toMatchObject({ value: 20 });
});

it("runs the derived body through a base reference and copies outputs", () => {
  const { runtime, value } = setup(
    "r := REF(devices[2]); r^(step := 3, count => first); second := r^.count;",
  );
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("first")).toMatchObject({ value: 6 });
  expect(value("second")).toMatchObject({ value: 6 });
  expect(value("r")).toEqual({ kind: "reference", target: "mainInstance.DEVICES[2]" });
  runtime.step();
  expect(value("first")).toMatchObject({ value: 12 });
});

it("casts between references and interfaces using the actual type, or yields NULL", () => {
  const { runtime, value } = setup(
    `r := REF(s); d ?= r; matched := r = d;
    a := r^; d := NULL; d ?= a; d^.Start(); first := d^.Value();
    a := NULL; a ?= r; r := NULL; r ?= a; second := r^.Value();
    r := REF(m); d ?= r; matched := matched AND d = NULL;
    a ?= NULL; r ?= a; other ?= REF(s); matched := matched AND other = NULL;`,
    "other: REF_TO Unrelated;",
    ["CLASS Unrelated END_CLASS"],
  );
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("first")).toMatchObject({ value: 10 });
  expect(value("second")).toMatchObject({ value: 10 });
  expect(value("matched")).toMatchObject({ value: true });
  expect(value("d")).toEqual({ kind: "reference", target: null });
  expect(value("r")).toEqual({ kind: "reference", target: null });
});

it.each(["r^.Start();", "r^(step := 1);", "first := r^.count;", "a := r^;"])(
  "faults on a NULL instance reference: %s",
  (body) => {
    const { runtime, value } = setup("d := REF(s); " + body);
    runtime.step();
    expect(runtime.diagnostic?.code).toBe("runtime.null-reference");
    expect(value("d")).toEqual({ kind: "reference", target: "mainInstance.S" });
  },
);

it("never retains instance references and clears them on restarts", () => {
  const { runtime, value, id, ir } = setup("r := REF(s); box.Bind(REF(s));", "box: Holder;", [
    `CLASS Holder VAR RETAIN link: REF_TO Motor; END_VAR
      METHOD PUBLIC Bind VAR_INPUT target: REF_TO Motor; END_VAR link := target; END_METHOD END_CLASS`,
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("box.link")).toEqual({ kind: "reference", target: "mainInstance.S" });
  expect(runtime.retentiveRecords()).toEqual([]);
  expect(() => runtime.write(id("r"), { dataType: "INT", value: 0 })).toThrow();
  expect(() => runtime.force(id("r"), { dataType: "INT", value: 0 })).toThrow();
  runtime.run();
  runtime.stop();
  expect(value("r")).toEqual({ kind: "reference", target: "mainInstance.S" });
  runtime.warmRestart();
  expect(value("r")).toEqual({ kind: "reference", target: null });
  expect(value("box.link")).toEqual({ kind: "reference", target: null });
  runtime.step();
  runtime.coldReset();
  expect(value("r")).toEqual({ kind: "reference", target: null });
  runtime.step();
  runtime.load(ir);
  expect(value("r")).toEqual({ kind: "reference", target: null });
});

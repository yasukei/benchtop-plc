import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

const actuator = `INTERFACE IActuator
METHOD Start VAR_INPUT step: INT; END_VAR END_METHOD
METHOD Value : INT END_METHOD
END_INTERFACE`;
const valve = `CLASS Valve IMPLEMENTS IActuator
VAR count: INT; END_VAR
METHOD PUBLIC Start VAR_INPUT step: INT; END_VAR count := count + step; END_METHOD
METHOD PUBLIC Value : INT Value := count; END_METHOD
END_CLASS`;
const pump = valve
  .replace("CLASS Valve", "FUNCTION_BLOCK Pump")
  .replace("END_CLASS", "END_FUNCTION_BLOCK")
  .replace("count + step", "count + step * 2");
function setup(body: string, declarations = "", extra: string[] = [], types: string[] = []) {
  const compiled = compileProject(
    [
      `PROGRAM Main VAR v: Valve; p: Pump; a: IActuator; b: IActuator; motors: ARRAY[1..2] OF IActuator; first, second: INT; matched: BOOL; ${declarations} END_VAR ${body} END_PROGRAM`,
      actuator,
      valve,
      pump,
      ...extra,
    ],
    types,
  );
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

it("traces Valve and Pump methods through an array of IActuator variables", () => {
  const { runtime, value } = setup(`motors[1] := v; motors[2] := p;
    motors[1].Start(step := 2); motors[2].Start(step := 3);
    first := motors[1].Value(); second := motors[2].Value();
    a := motors[1]; b := v; matched := a = b;`);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("first")).toMatchObject({ value: 2 });
  expect(value("second")).toMatchObject({ value: 6 });
  expect(value("matched")).toMatchObject({ value: true });
  expect(value("a")).toEqual({ kind: "reference", target: "mainInstance.V" });
  runtime.step();
  expect(value("first")).toMatchObject({ value: 4 });
  expect(value("second")).toMatchObject({ value: 12 });
});

it("traces successful and mismatched assignment attempts without a fault", () => {
  const { runtime, value } = setup(
    `a := v; empty ?= a; matched := empty = NULL;
    b ?= a; b.Start(step := 2); first := b.Value();
    b ?= empty; a ?= NULL;`,
    "empty: IEmpty;",
    ["INTERFACE IEmpty END_INTERFACE"],
  );
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("matched")).toMatchObject({ value: true });
  expect(value("first")).toMatchObject({ value: 2 });
  expect(value("a")).toEqual({ kind: "reference", target: null });
  expect(value("b")).toEqual({ kind: "reference", target: null });
});

it("faults through NULL and preserves bound targets on FAULT", () => {
  const { runtime, value } = setup("b := v; a.Start(step := 1);");
  runtime.step();
  expect(runtime.diagnostic?.code).toBe("runtime.null-reference");
  expect(value("b")).toEqual({ kind: "reference", target: "mainInstance.V" });
});

it("passes interface input/output/in-out parameters, results and structure leaves", () => {
  const { runtime, value } = setup(
    `record.link := Pass(v);
    a := record.link; a.Start(step := 4); first := a.Value();
    adapter.Swap(value := a, changed := b, resultValue => record.link);
    record.link.Start(step := 2); second := b.Value();`,
    "record: Holder; adapter: Bridge;",
    [
      "FUNCTION Pass : IActuator VAR_INPUT value: IActuator; END_VAR Pass := value; END_FUNCTION",
      `CLASS Bridge
    METHOD PUBLIC Swap VAR_INPUT value: IActuator; END_VAR
    VAR_IN_OUT changed: IActuator; END_VAR VAR_OUTPUT resultValue: IActuator; END_VAR
    changed := value; resultValue := value; END_METHOD END_CLASS`,
    ],
    ["TYPE Holder : STRUCT link: IActuator; END_STRUCT; END_TYPE"],
  );
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("first")).toMatchObject({ value: 4 });
  expect(value("second")).toMatchObject({ value: 6 });
});

it("maps interface prototype parameters to the actual implementation layout", () => {
  const face = `INTERFACE ITransform METHOD Apply : INT VAR_INPUT amount: INT; END_VAR
    VAR_OUTPUT seen: INT; END_VAR VAR_IN_OUT total: INT; END_VAR END_METHOD END_INTERFACE`;
  const { runtime, value } = setup(
    "transform := device; first := transform.Apply(amount := 3, total := second, seen => first);",
    "transform: ITransform; device: Worker;",
    [
      face,
      `CLASS Worker IMPLEMENTS ITransform VAR extra: INT := 5; END_VAR
    METHOD PUBLIC Apply : INT VAR_INPUT amount: INT; END_VAR VAR_OUTPUT seen: INT; END_VAR VAR_IN_OUT total: INT; END_VAR
    total := total + amount; seen := extra; Apply := total + extra; END_METHOD END_CLASS`,
    ],
  );
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("first")).toMatchObject({ value: 8 });
  expect(value("second")).toMatchObject({ value: 3 });
});

it("binds THIS and calls overrides on actual derived types", () => {
  const { runtime, value } = setup(
    "a := d.GetSelf(); a.Start(step := 2); first := a.Value();",
    "d: Derived;",
    [
      valve
        .replace("CLASS Valve", "CLASS BaseValve")
        .replace(
          "END_CLASS",
          "METHOD PUBLIC GetSelf : IActuator GetSelf := THIS; END_METHOD END_CLASS",
        ),
      `CLASS Derived EXTENDS BaseValve METHOD PUBLIC OVERRIDE Value : INT Value := 99; END_METHOD END_CLASS`,
    ],
  );
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("first")).toMatchObject({ value: 99 });
  expect(value("a")).toEqual({ kind: "reference", target: "mainInstance.D" });
});

it("clears interfaces on load, warm restart, cold reset and reload, while preserving them on STOP/RUN and scans", () => {
  const { runtime, ir, value, id } = setup("a := v; motors[1] := p;", "");
  expect(value("a")).toEqual({ kind: "reference", target: null });
  runtime.step();
  expect(value("a")).toEqual({ kind: "reference", target: "mainInstance.V" });
  runtime.run();
  runtime.stop();
  expect(value("a")).toEqual({ kind: "reference", target: "mainInstance.V" });
  expect(() => runtime.write(id("a"), { dataType: "INT", value: 0 })).toThrow();
  expect(() => runtime.force(id("a"), { dataType: "INT", value: 0 })).toThrow();
  const records = runtime.retentiveRecords();
  expect(records).toEqual([]);
  runtime.warmRestart();
  expect(value("a")).toEqual({ kind: "reference", target: null });
  expect(value("motors[1]")).toEqual({ kind: "reference", target: null });
  runtime.step();
  runtime.coldReset();
  expect(value("a")).toEqual({ kind: "reference", target: null });
  runtime.step();
  runtime.load(ir);
  expect(value("a")).toEqual({ kind: "reference", target: null });
  expect(runtime.restoreRetentive(records)).toEqual([]);
  expect(value("a")).toEqual({ kind: "reference", target: null });
});

it("never retains interface leaves nested inside a RETAIN instance", () => {
  const { runtime, value } = setup("box.Bind(value := v);", "box: Retainer;", [
    `CLASS Retainer VAR RETAIN link: IActuator; links: ARRAY[1..2] OF IActuator; END_VAR
    METHOD PUBLIC Bind VAR_INPUT value: IActuator; END_VAR link := value; links[1] := value; END_METHOD END_CLASS`,
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("box.link")).toEqual({ kind: "reference", target: "mainInstance.V" });
  expect(runtime.retentiveRecords()).toEqual([]);
  runtime.warmRestart();
  expect(value("box.link")).toEqual({ kind: "reference", target: null });
  expect(value("box.links[1]")).toEqual({ kind: "reference", target: null });
});

it("binds a global class instance through a global interface variable", () => {
  const compiled = compileProject(
    [
      `PROGRAM Main VAR_EXTERNAL globalValve: Valve; shared: IActuator; END_VAR
    VAR_OUTPUT observed: INT; END_VAR shared := globalValve; shared.Start(step := 3); observed := shared.Value(); END_PROGRAM`,
      actuator,
      valve,
    ],
    [],
    `CONFIGURATION Config VAR_GLOBAL RETAIN globalValve: Valve; shared: IActuator; END_VAR
    RESOURCE Res ON BENCHTOP TASK Cycle(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM mainInstance WITH Cycle: Main; END_RESOURCE END_CONFIGURATION`,
  );
  expect(compiled.diagnostics).toEqual([]);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(compiled.ir!);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  const variable = (name: string) =>
    snapshotVariable(
      runtime.snapshot(),
      compiled.ir!.variables.findIndex((v) => v.key === name),
    );
  expect(variable("SHARED")).toEqual({ kind: "reference", target: "GLOBALVALVE" });
  expect(variable("MAININSTANCE.OBSERVED")).toMatchObject({ value: 3 });
  runtime.warmRestart();
  expect(variable("SHARED")).toEqual({ kind: "reference", target: null });
});

it("binds grouped instances, THIS and array elements", () => {
  const { runtime, value } = setup(
    "a := ((v)); a.Start(step := 2); b := (devices[2]); b.Start(step := 3); first := a.Value(); second := b.Value();",
    "devices: ARRAY[1..2] OF Valve;",
  );
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("first")).toMatchObject({ value: 2 });
  expect(value("second")).toMatchObject({ value: 3 });
  expect(value("a")).toEqual({ kind: "reference", target: "mainInstance.V" });
  expect(value("b")).toEqual({ kind: "reference", target: "mainInstance.DEVICES[2]" });
});

it("passes interface values through function block input, output, in-out and temporary sections", () => {
  const { runtime, value } = setup(
    "linker(source := v, outputAlias := b, mirrored => a); a.Start(step := 3); first := b.Value();",
    "linker: Connector;",
    [
      `FUNCTION_BLOCK Connector VAR_INPUT source: IActuator; END_VAR VAR_OUTPUT mirrored: IActuator; END_VAR
    VAR_IN_OUT outputAlias: IActuator; END_VAR VAR_TEMP scratch: IActuator; END_VAR
    scratch := source; mirrored := scratch; outputAlias := scratch; END_FUNCTION_BLOCK`,
    ],
  );
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("first")).toMatchObject({ value: 3 });
});

it("resets interface-only FUNCTION and method temporaries on every call", () => {
  const locals = `VAR_INPUT source: IActuator; END_VAR
    VAR_TEMP scratch: IActuator; links: ARRAY[1..1] OF ARRAY[1..1] OF IActuator; END_VAR`;
  const body = `Fresh := (scratch = NULL) AND (links[1][1] = NULL);
    scratch := source; links[1][1] := source;`;
  const { runtime, value } = setup(
    `IF Fresh(v) AND Fresh(p) THEN first := first + 1; END_IF;
    IF inspector.Fresh(source := v) AND inspector.Fresh(source := p) THEN second := second + 1; END_IF;`,
    "inspector: Helper;",
    [
      `FUNCTION Fresh : BOOL ${locals} ${body} END_FUNCTION`,
      `CLASS Helper METHOD PUBLIC Fresh : BOOL ${locals} ${body} END_METHOD END_CLASS`,
    ],
  );
  for (let scan = 1; scan <= 2; scan++) {
    runtime.step();
    expect(runtime.diagnostic).toBeNull();
    expect(value("first")).toMatchObject({ value: scan });
    expect(value("second")).toMatchObject({ value: scan });
  }
});

it.each(["PROGRAM VAR_IN_OUT", "FUNCTION VAR_TEMP", "METHOD VAR_TEMP"])(
  "restricts %s to interface-only declarations",
  (context) => {
    const [kind, section] = context.split(" ");
    for (const declarations of [
      "ordinary: INT;",
      "ordinary: ARRAY[1..2] OF INT;",
      "record: Holder;",
      "link: IActuator; ordinary: INT;",
      `link: IActuator; END_VAR ${section} ordinary: INT;`,
    ]) {
      const sections = `${section} ${declarations} END_VAR`;
      const sources = [
        actuator,
        kind === "PROGRAM" ? `PROGRAM Main ${sections} END_PROGRAM` : "PROGRAM Main END_PROGRAM",
        ...(kind === "PROGRAM"
          ? []
          : kind === "FUNCTION"
            ? [`FUNCTION Check ${sections} END_FUNCTION`]
            : [`CLASS Check METHOD PUBLIC Run ${sections} END_METHOD END_CLASS`]),
      ];
      const compiled = compileProject(sources, [
        "TYPE Holder : STRUCT link: IActuator; END_STRUCT; END_TYPE",
      ]);
      expect(compiled.ir, `${context}: ${declarations}`).toBeUndefined();
      expect(compiled.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "pou.invalid-section",
          args: { section, kind: kind === "PROGRAM" ? "program" : "function" },
        }),
      );
    }
  },
);

it("aliases configured PROGRAM interface in-outs so retargeting is immediately shared", () => {
  const compiled = compileProject(
    [
      `PROGRAM Main VAR_IN_OUT a: IActuator; second: IActuator; END_VAR
    VAR_EXTERNAL shared: IActuator; globalValve: Valve; END_VAR
    VAR_OUTPUT observed: INT; identical: BOOL; END_VAR
    a := globalValve; shared.Start(step := 3); observed := a.Value(); identical := a = second;
    END_PROGRAM`,
      actuator,
      valve,
    ],
    [],
    `CONFIGURATION Config VAR_GLOBAL RETAIN shared: IActuator; globalValve: Valve; END_VAR
    RESOURCE Res ON BENCHTOP TASK Cycle(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM mainInstance WITH Cycle: Main(a := shared, second := shared); END_RESOURCE END_CONFIGURATION`,
  );
  expect(compiled.diagnostics).toEqual([]);
  const ir = structuredClone(compiled.ir!);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  const value = (name: string) =>
    snapshotVariable(
      runtime.snapshot(),
      ir.variables.findIndex((v) => v.key === name),
    );
  expect(value("SHARED")).toEqual({ kind: "reference", target: null });
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("SHARED")).toEqual({ kind: "reference", target: "GLOBALVALVE" });
  expect(value("MAININSTANCE.OBSERVED")).toMatchObject({ value: 3 });
  expect(value("MAININSTANCE.IDENTICAL")).toMatchObject({ value: true });
  runtime.warmRestart();
  expect(value("SHARED")).toEqual({ kind: "reference", target: null });
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("MAININSTANCE.OBSERVED")).toMatchObject({ value: 6 });
  expect(value("MAININSTANCE.IDENTICAL")).toMatchObject({ value: true });
});

it("aliases configured PROGRAM interface array cells in both directions", () => {
  const compiled = compileProject(
    [
      `PROGRAM Main VAR_IN_OUT links: ARRAY[1..2] OF IActuator; END_VAR
    VAR_EXTERNAL shared: ARRAY[1..2] OF IActuator; globalValve: Valve; globalPump: Pump; END_VAR
    VAR i: INT := 1; END_VAR
    VAR_OUTPUT forwarded, reversed: BOOL; observed: INT; END_VAR
    links[i] := globalValve; forwarded := shared[i] = links[i];
    shared[i + 1] := globalPump; reversed := links[i + 1] = shared[i + 1];
    links[i + 1].Start(step := 3); observed := shared[i + 1].Value();
    END_PROGRAM`,
      actuator,
      valve,
      pump,
    ],
    [],
    `CONFIGURATION Config VAR_GLOBAL shared: ARRAY[1..2] OF IActuator; globalValve: Valve; globalPump: Pump; END_VAR
    RESOURCE Res ON BENCHTOP TASK Cycle(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM mainInstance WITH Cycle: Main(links := shared); END_RESOURCE END_CONFIGURATION`,
  );
  expect(compiled.diagnostics).toEqual([]);
  const ir = structuredClone(compiled.ir!);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  runtime.watch(ir.variables.map((_, id) => id));
  const value = (name: string) =>
    snapshotVariable(
      runtime.snapshot(),
      ir.variables.findIndex((v) => v.key === name),
    );
  for (let scan = 1; scan <= 2; scan++) {
    runtime.step();
    expect(runtime.diagnostic).toBeNull();
    expect(value("SHARED[1]")).toEqual({ kind: "reference", target: "GLOBALVALVE" });
    expect(value("SHARED[2]")).toEqual({ kind: "reference", target: "GLOBALPUMP" });
    expect(value("MAININSTANCE.FORWARDED")).toMatchObject({ value: true });
    expect(value("MAININSTANCE.REVERSED")).toMatchObject({ value: true });
    expect(value("MAININSTANCE.OBSERVED")).toMatchObject({ value: scan * 6 });
  }
});

import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable } from "@benchtop-plc/core";
import {
  createRuntime,
  RuntimeCommandRejected,
  VirtualClock,
  VirtualTicker,
} from "@benchtop-plc/runtime";

const main = `PROGRAM Main VAR_INPUT In : BOOL; END_VAR VAR_OUTPUT Out : BOOL; END_VAR Out := In; END_PROGRAM`;
function setup(instances: string, globals = "", program = main, overlaps = 0) {
  const result = compileProject(
    [program],
    [],
    `CONFIGURATION Plant ${globals} RESOURCE Station ON Cpu TASK T (INTERVAL := T#10ms, PRIORITY := 1); ${instances} END_RESOURCE END_CONFIGURATION`,
  );
  expect(result.diagnostics.map((d) => d.code)).toEqual(
    Array(overlaps).fill("decl.output-overlap"),
  );
  const ir = structuredClone(result.ir!);
  const clock = new VirtualClock();
  const inputs: import("@benchtop-plc/core").IoImage = [0, ...Array<number>(63).fill(0)];
  const runtime = createRuntime({
    clock,
    ticker: new VirtualTicker(clock),
    stages: { readInputs: () => inputs },
  });
  runtime.load(ir);
  const id = (name: string) => ir.variables.findIndex((v) => v.key === name.toUpperCase());
  const value = (name: string) => snapshotVariable(runtime.snapshot(), id(name));
  return { runtime, clock, id, value, inputs };
}

it("traces independent input/output connections on two instances", () => {
  const { runtime, clock, value, inputs } = setup(
    "PROGRAM A WITH T : Main (In := %IX0.0, Out => %QX0.0); PROGRAM B WITH T : Main (In := %IX0.1, Out => %QX0.1);",
  );
  runtime.run();
  for (const [a, b] of [
    [true, false],
    [false, true],
    [true, true],
    [false, false],
  ] as const) {
    inputs[0] = Number(a) | (Number(b) << 1);
    clock.advance(10);
    expect(value("A.In")).toMatchObject({ value: a });
    expect(value("B.Out")).toMatchObject({ value: b });
    expect(runtime.snapshot().outputs[0]).toBe(Number(a) | (Number(b) << 1));
  }
});

it("traces same-run copies and forces at every parameter boundary", () => {
  const { runtime, id, value } = setup(
    "PROGRAM A WITH T : Main (In := TRUE, Out => g); PROGRAM B WITH T : Main (In := g, Out => %QX0.0);",
    "VAR_GLOBAL g : BOOL; END_VAR",
  );
  runtime.step();
  expect(value("B.In")).toMatchObject({ value: true });
  runtime.force(id("g"), { dataType: "BOOL", value: false });
  runtime.step();
  expect(value("g")).toMatchObject({ value: false });
  expect(value("B.In")).toMatchObject({ value: false });
  runtime.force(id("g"), null);
  runtime.force(id("A.Out"), { dataType: "BOOL", value: false });
  runtime.step();
  expect(value("B.In")).toMatchObject({ value: false });
  runtime.force(id("A.Out"), null);
  runtime.force(id("B.In"), { dataType: "BOOL", value: false });
  runtime.step();
  expect(value("g")).toMatchObject({ value: true });
  expect(value("B.Out")).toMatchObject({ value: false });
});

it("rejects writes to connected inputs while allowing forces, outputs and unconnected inputs", () => {
  const { runtime, id, value } = setup(
    "PROGRAM A WITH T : Main (In := FALSE, Out => g); PROGRAM B WITH T : Main;",
    "VAR_GLOBAL g : BOOL; END_VAR",
  );
  expect(() => runtime.write(id("A.In"), { dataType: "BOOL", value: true })).toThrow(
    RuntimeCommandRejected,
  );
  runtime.write(id("A.Out"), { dataType: "BOOL", value: true });
  expect(value("A.Out")).toMatchObject({ value: true });
  runtime.write(id("B.In"), { dataType: "BOOL", value: true });
  runtime.force(id("A.In"), { dataType: "BOOL", value: true });
  runtime.step();
  runtime.step();
  expect(value("A.Out")).toMatchObject({ value: true });
  expect(value("B.Out")).toMatchObject({ value: true });
});

it("copies widened values, aggregate values and references through global storage", () => {
  const { runtime, value } = setup(
    "PROGRAM A WITH T : Main (small := n, text := message, items := g, pointer := r, large => out);",
    `VAR_GLOBAL n : SINT := 7; message : STRING[6] := 'abcdef'; out : LINT; g : ARRAY[1..2] OF INT := [4,5]; r : REF_TO INT; END_VAR`,
    `PROGRAM Main VAR_INPUT small : DINT; text : STRING[3]; items : ARRAY[1..2] OF INT; pointer : REF_TO INT; END_VAR VAR_OUTPUT large : DINT; END_VAR large := small + items[2] + LEN(text); END_PROGRAM`,
  );
  runtime.step();
  expect(value("out")).toMatchObject({ value: "15" });
});

it("restores a forced located source before input copies and a forced destination after output copies", () => {
  const { runtime, clock, id, value } = setup(
    "PROGRAM A WITH T : Main (In := %IX0.0, Out => %QX0.0);",
    "VAR_GLOBAL input AT %IX0.0 : BOOL; lamp AT %QX0.0 : BOOL; END_VAR",
    main,
    1,
  );
  runtime.force(id("input"), { dataType: "BOOL", value: true });
  runtime.force(id("lamp"), { dataType: "BOOL", value: false });
  runtime.run();
  clock.advance(10);
  expect(value("A.In")).toMatchObject({ value: true });
  expect(value("A.Out")).toMatchObject({ value: true });
  expect(runtime.snapshot().outputs[0]).toBe(0);
});

it("faults on an out-of-range input copy before executing its instance", () => {
  const { runtime, id, value } = setup(
    "PROGRAM A WITH T : Main (requested := g);",
    "VAR_GLOBAL g : INT; END_VAR",
    "PROGRAM Main VAR_INPUT requested : INT(0..10); END_VAR VAR ran : BOOL; END_VAR ran := TRUE; END_PROGRAM",
  );
  runtime.write(id("g"), { dataType: "INT", value: 11 });
  runtime.step();
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.subrange-violation",
    sourceKind: "configuration",
    sourceIndex: 0,
    pou: "Plant",
    instance: "A",
    task: "T",
  });
  expect(value("A.ran")).toMatchObject({ value: false });
});

it.each(["VAR_INPUT", "VAR_OUTPUT"])(
  "requires configuration connections instead of AT on PROGRAM %s",
  (section) => {
    const result = compileProject([
      `PROGRAM Main ${section} signal AT %QX0.0 : BOOL; END_VAR END_PROGRAM`,
    ]);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "decl.parameter-address", pou: "Main" }),
    );
  },
);

it("requires a connection after each comma in a configuration program declaration", () => {
  const result = compileProject(
    [main],
    [],
    `CONFIGURATION Plant RESOURCE Station ON Cpu
TASK T (INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM A WITH T : Main (In := TRUE,);
END_RESOURCE END_CONFIGURATION`,
  );
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code: "syntax.expected-identifier",
      sourceKind: "configuration",
      pou: "Plant",
      span: expect.objectContaining({ line: 3 }),
    }),
  ]);
});

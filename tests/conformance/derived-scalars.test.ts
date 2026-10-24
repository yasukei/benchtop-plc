import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { type RuntimeSnapshot } from "@benchtop-plc/core";
import {
  createRuntime,
  RuntimeCommandRejected,
  VirtualClock,
  VirtualTicker,
} from "@benchtop-plc/runtime";

const state = "TYPE State : (Idle, Running, Done); END_TYPE";
const percent = "TYPE Percent : INT (0..100); END_TYPE";
function setup(pous: string[], types = [state, percent]) {
  const compiled = compileProject(pous, types);
  expect(compiled.diagnostics).toEqual([]);
  const ir = JSON.parse(JSON.stringify(compiled.ir)) as NonNullable<typeof compiled.ir>;
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  const id = (name: string) =>
    ir.variables.findIndex((variable) => variable.key === `MAININSTANCE.${name.toUpperCase()}`);
  const value = (snapshot: RuntimeSnapshot, name: string) => snapshot.variables[id(name)];
  return { ir, runtime, clock, id, value };
}

it.each([
  ["LREAL", "DIV(7, 2)", 3],
  ["LINT", "MUL(100000, 100000)", "1410065408"],
  ["LREAL", "MOVE(DIV(7, 2))", 3],
  ["LREAL", "SEL(TRUE, DIV(7, 2), DIV(9, 2))", 4],
  ["LREAL", "MUX(0, DIV(7, 2), DIV(9, 2))", 3],
] as const)(
  "preserves elementary argument semantics for %s := %s without data type sources",
  (dataType, expression, expected) => {
    const { runtime, value } = setup(
      [`PROGRAM Main VAR target : ${dataType}; END_VAR target := ${expression}; END_PROGRAM`],
      [],
    );
    expect(value(runtime.step(), "target")).toEqual({ kind: "scalar", dataType, value: expected });
    expect(runtime.diagnostic).toBeNull();
  },
);

it("traces an enumerated state machine over scans with one integer cell per variable", () => {
  const { runtime, value, ir } = setup([
    `PROGRAM Main VAR phase : State; END_VAR
    CASE phase OF
      Idle: phase := State#Running;
      Running: phase := Done;
      Done: phase := Idle;
    END_CASE; END_PROGRAM`,
  ]);
  expect(ir.variables).toHaveLength(1);
  const trace = [runtime.snapshot(), runtime.step(), runtime.step(), runtime.step()].map(
    (snapshot) => value(snapshot, "phase"),
  );
  expect(trace).toEqual([0, 1, 2, 0].map((value) => ({ kind: "scalar", dataType: "INT", value })));
  expect(runtime.diagnostic).toBeNull();
  runtime.coldReset();
  expect(value(runtime.snapshot(), "phase")).toEqual({ kind: "scalar", dataType: "INT", value: 0 });
});

it("runs same-type enum selection, equality and constants", () => {
  const { runtime, value } = setup([
    `PROGRAM Main
    VAR CONSTANT Final : State := Done; END_VAR
    VAR a, b, c : State; equal : BOOL; END_VAR
    a := SEL(TRUE, Idle, Running); b := MUX(1, Idle, Final); c := MOVE(a);
    equal := (a = c) AND (b <> c); END_PROGRAM`,
  ]);
  const snapshot = runtime.step();
  expect(["a", "b", "c", "equal"].map((name) => value(snapshot, name))).toEqual([
    { kind: "scalar", dataType: "INT", value: 1 },
    { kind: "scalar", dataType: "INT", value: 2 },
    { kind: "scalar", dataType: "INT", value: 1 },
    { kind: "scalar", dataType: "BOOL", value: true },
  ]);
});

it("carries enumerations through function results, inputs, outputs and in-outs and FB members", () => {
  const { runtime, value } = setup([
    `PROGRAM Main VAR phase : State; resultValue, outValue : State; unit : Machine; END_VAR
    resultValue := Advance(input := Running, output => outValue, current := phase);
    unit(input := resultValue, current := phase, output => outValue); END_PROGRAM`,
    `FUNCTION Advance : State VAR_INPUT input : State; END_VAR VAR_OUTPUT output : State; END_VAR VAR_IN_OUT current : State; END_VAR
    VAR local : State; END_VAR local := input; current := local; output := Done; Advance := current; END_FUNCTION`,
    `FUNCTION_BLOCK Machine VAR_INPUT input : State; END_VAR VAR_OUTPUT output : State; END_VAR VAR_IN_OUT current : State; END_VAR
    VAR local : State; END_VAR local := input; current := Done; output := local; END_FUNCTION_BLOCK`,
  ]);
  const snapshot = runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(
    ["phase", "resultValue", "outValue", "unit.input", "unit.output", "unit.local"].map((name) =>
      value(snapshot, name),
    ),
  ).toEqual([2, 1, 1, 1, 1, 1].map((value) => ({ kind: "scalar", dataType: "INT", value })));
});

it("defaults subranges to the lower bound and faults at a dynamic store without changing the target", () => {
  const { runtime, value } = setup(
    [
      `PROGRAM Main VAR p : Percent; source : INT := 40; offsetValue : Offset; END_VAR
    p := source; source := source + 40; END_PROGRAM`,
    ],
    [percent, "TYPE Offset : INT (-10..10); END_TYPE"],
  );
  expect(value(runtime.snapshot(), "offsetValue")).toEqual({
    kind: "scalar",
    dataType: "INT",
    value: -10,
  });
  const trace = [runtime.step(), runtime.step(), runtime.step()].map((snapshot) =>
    value(snapshot, "p"),
  );
  expect(trace).toEqual([40, 80, 80].map((value) => ({ kind: "scalar", dataType: "INT", value })));
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.subrange-violation",
    pou: "Main",
    args: { value: 120, lower: 0, upper: 100 },
  });
});

it.each([
  [
    "PROGRAM Main VAR p : Percent; source : INT := 120; END_VAR F(input := source); END_PROGRAM",
    "FUNCTION F VAR_INPUT input : Percent; END_VAR END_FUNCTION",
  ],
  [
    "PROGRAM Main VAR p : Percent; source : INT := 120; END_VAR p := F(input := source); END_PROGRAM",
    "FUNCTION F : Percent VAR_INPUT input : INT; END_VAR F := input; END_FUNCTION",
  ],
  [
    "PROGRAM Main VAR p : Percent; END_VAR F(output => p); END_PROGRAM",
    "FUNCTION F VAR_OUTPUT output : INT := 120; END_VAR END_FUNCTION",
  ],
  [
    "PROGRAM Main VAR b : Block; source : INT := 120; END_VAR b(input := source); END_PROGRAM",
    "FUNCTION_BLOCK Block VAR_INPUT input : Percent; END_VAR END_FUNCTION_BLOCK",
  ],
  [
    "PROGRAM Main VAR b : Block; p : Percent; END_VAR b(output => p); END_PROGRAM",
    "FUNCTION_BLOCK Block VAR_OUTPUT output : INT := 120; END_VAR END_FUNCTION_BLOCK",
  ],
  [
    "PROGRAM Main VAR p : Percent; source : INT := 120; END_VAR F(current := p, input := source); END_PROGRAM",
    "FUNCTION F VAR_IN_OUT current : INT (0..100); END_VAR VAR_INPUT input : INT; END_VAR current := input; END_FUNCTION",
  ],
])("checks every parameter store: %s", (...pous) => {
  const { runtime } = setup(pous);
  runtime.step();
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.subrange-violation",
    args: { value: 120, lower: 0, upper: 100 },
  });
});

it("rejects invalid writes and forces without mutation or a fault, and applies valid values", () => {
  const { runtime, id, value } = setup([
    "PROGRAM Main VAR phase : State; p : Percent; END_VAR END_PROGRAM",
  ]);
  runtime.write(id("phase"), { dataType: "INT", value: 1 });
  runtime.force(id("p"), { dataType: "INT", value: 50 });
  runtime.step();
  for (const method of ["write", "force"] as const) {
    expect(() => runtime[method](id("phase"), { dataType: "INT", value: 3 })).toThrow(
      RuntimeCommandRejected,
    );
    expect(() => runtime[method](id("p"), { dataType: "INT", value: 120 })).toThrow(
      RuntimeCommandRejected,
    );
  }
  const snapshot = runtime.step();
  expect(value(snapshot, "phase")).toEqual({ kind: "scalar", dataType: "INT", value: 1 });
  expect(value(snapshot, "p")).toEqual({ kind: "scalar", dataType: "INT", value: 50 });
  expect(snapshot.forced).toEqual([id("p")]);
  expect(runtime.state).toBe("STOP");
  expect(runtime.diagnostic).toBeNull();
});

it("preserves exact 64-bit enum values, limits, defaults and snapshots", () => {
  const { runtime, value } = setup(
    ["PROGRAM Main VAR enumValue : E; rangeValue : P; END_VAR enumValue := E#Last; END_PROGRAM"],
    [
      "TYPE E : ULINT (First := 18446744073709551614, Last); END_TYPE",
      "TYPE P : LINT (-9007199254740993..9007199254740993); END_TYPE",
    ],
  );
  const snapshot = runtime.step();
  expect(value(snapshot, "enumValue")).toEqual({
    kind: "scalar",
    dataType: "ULINT",
    value: "18446744073709551615",
  });
  expect(value(snapshot, "rangeValue")).toEqual({
    kind: "scalar",
    dataType: "LINT",
    value: "-9007199254740993",
  });
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
});

it("reports exact 64-bit subrange diagnostic arguments", () => {
  const { runtime } = setup(
    [
      "PROGRAM Main VAR rangeValue : Bounded; source : LINT := 9007199254740993; END_VAR rangeValue := source; END_PROGRAM",
    ],
    ["TYPE Bounded : LINT (-9007199254740992..9007199254740992); END_TYPE"],
  );
  runtime.step();
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.subrange-violation",
    args: { value: "9007199254740993", lower: "-9007199254740992", upper: "9007199254740992" },
  });
});

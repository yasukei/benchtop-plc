import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";
import { snapshotVariable } from "@benchtop-plc/core";

function setup(pous: string[], types: string[] = []) {
  const compiled = compileProject(pous, types);
  expect(compiled.diagnostics).toEqual([]);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(compiled.ir!);
  runtime.watch(compiled.ir!.variables.map((_, id) => id));
  const value = (name: string) =>
    snapshotVariable(
      runtime.snapshot(),
      compiled.ir!.variables.findIndex((v) => v.key === `MAININSTANCE.${name.toUpperCase()}`),
    );
  return { runtime, value, ir: compiled.ir! };
}
const main = (body: string, declarations = "x: INT;") =>
  `PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`;
const conditional = `FUNCTION Choose : INT VAR_INPUT enabled: BOOL; END_VAR
IF enabled THEN Choose := 7; ELSE Choose := 9; END_IF; END_FUNCTION`;

it("assigns on every path and returns the most recent assignment", () => {
  const { runtime, value } = setup([
    main("x := Choose(TRUE); y := Choose(FALSE); z := Last();", "x,y,z: INT;"),
    conditional,
    "FUNCTION Last : INT Last := 1; Last := 2; RETURN; Last := 3; END_FUNCTION",
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect([value("x"), value("y"), value("z")]).toMatchObject([
    { value: 7 },
    { value: 9 },
    { value: 2 },
  ]);
});

it.each([
  ["FOR Count := 1 TO 3 DO END_FOR;", 4],
  ["FOR Count := 5 TO 3 DO END_FOR;", 5],
] as const)("counts result writes in a FOR control variable: %s", (body, expected) => {
  const { runtime, value } = setup([
    main("x := Count();"),
    `FUNCTION Count : INT ${body} END_FUNCTION`,
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("x")).toMatchObject({ value: expected });
});

it.each([
  "IF enabled THEN Choose := 7; END_IF;",
  "IF NOT enabled THEN RETURN; END_IF; Choose := 7;",
  "WHILE enabled DO Choose := 7; EXIT; END_WHILE;",
])("faults when this invocation executes no result write: %s", (body) => {
  const { runtime } = setup([
    main("x := Choose(TRUE); x := Choose(FALSE);"),
    `FUNCTION Choose : INT VAR_INPUT enabled: BOOL; END_VAR ${body} END_FUNCTION`,
  ]);
  runtime.step();
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.result-not-assigned",
    pou: "Choose",
    instance: "mainInstance",
    args: {},
  });
});

it.each([
  "FUNCTION Empty : INT END_FUNCTION",
  "FUNCTION Empty : INT VAR x: INT; END_VAR x := Empty; END_FUNCTION",
  "FUNCTION Empty : REF_TO INT Empty^ := 1; END_FUNCTION",
])("rejects a result without a possible assignment: %s", (source) => {
  const compiled = compileProject([main(""), source]);
  expect(compiled.ir).toBeUndefined();
  expect(compiled.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "pou.result-not-assigned",
      pou: "Empty",
      args: { name: "Empty" },
    }),
  );
});

it.each([
  {
    name: "unknown function with an output target",
    sources: ["FUNCTION F : INT Nope(q => F); END_FUNCTION"],
    expected: ["call.unknown-function"],
  },
  {
    name: "unknown method with an output target",
    sources: ["CLASS Block METHOD PUBLIC M : INT THIS.Nope(o => M); END_METHOD END_CLASS"],
    expected: ["method.unknown"],
  },
  {
    name: "non-formal call with an in-out actual",
    sources: [
      "FUNCTION F : INT G(F); END_FUNCTION",
      "FUNCTION G VAR_IN_OUT v: INT; END_VAR END_FUNCTION",
    ],
    expected: ["call.formal-required", "call.argument-count", "call.missing-in-out"],
  },
])("avoids a follow-on result diagnostic for $name", ({ sources, expected }) => {
  const compiled = compileProject([main(""), ...sources]);
  expect(compiled.ir).toBeUndefined();
  expect(compiled.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expected);
});

it("still diagnoses a missing result assignment when the body only has a warning", () => {
  const compiled = compileProject([
    main(""),
    "FUNCTION F : INT REAL_TO_DWORD(REAL#1.0); END_FUNCTION",
  ]);
  expect(compiled.ir).toBeUndefined();
  expect(compiled.diagnostics.map(({ code, severity }) => ({ code, severity }))).toEqual([
    { code: "type.portability", severity: "warning" },
    { code: "pou.result-not-assigned", severity: "error" },
  ]);
});

it("rejects concrete methods, but exempts interface prototypes and abstract methods", () => {
  const compiled = compileProject([
    main(""),
    "CLASS Concrete METHOD Value : INT END_METHOD END_CLASS",
  ]);
  expect(compiled.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "pou.result-not-assigned",
      pou: "Value",
    }),
  );
  expect(
    compileProject([
      main(""),
      "INTERFACE I METHOD Value : INT END_METHOD END_INTERFACE",
      "CLASS ABSTRACT Base METHOD PUBLIC ABSTRACT Value : INT END_METHOD END_CLASS",
    ]).diagnostics,
  ).toEqual([]);
});

it("tracks method results per invocation and reports the receiver instance", () => {
  const { runtime, value } = setup([
    main("x := b.Value(TRUE); y := b.Value(FALSE);", "x,y: INT; b: Block;"),
    `FUNCTION_BLOCK Block METHOD PUBLIC Value : INT VAR_INPUT enabled: BOOL; END_VAR
     IF enabled THEN Value := 4; END_IF; END_METHOD END_FUNCTION_BLOCK`,
  ]);
  runtime.step();
  expect(value("x")).toMatchObject({ value: 4 });
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.result-not-assigned",
    pou: "Block.Value",
    instance: "mainInstance.B",
  });
});

it("counts member, element, bit and reference-result assignments", () => {
  const { runtime, value } = setup(
    [
      main(
        "p := PointResult(); a := ArrayResult(); wordValue := Bits(); r := ReferenceResult();",
        "p: Point; a: ARRAY[1..2] OF INT; wordValue: WORD; r: REF_TO INT;",
      ),
      "FUNCTION PointResult : Point PointResult.x := 5; END_FUNCTION",
      "FUNCTION ArrayResult : ARRAY[1..2] OF INT ArrayResult[2] := 6; END_FUNCTION",
      "FUNCTION Bits : WORD Bits.1 := TRUE; END_FUNCTION",
      "FUNCTION ReferenceResult : REF_TO INT ReferenceResult := NULL; END_FUNCTION",
    ],
    ["TYPE Point : STRUCT x,y: INT; END_STRUCT; END_TYPE"],
  );
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect([
    value("p.x"),
    value("p.y"),
    value("a[1]"),
    value("a[2]"),
    value("wordValue"),
  ]).toMatchObject([{ value: 5 }, { value: 0 }, { value: 0 }, { value: 6 }, { value: 2 }]);
});

it.each([
  ["Copy(q => Result);", "FUNCTION Copy VAR_OUTPUT q: INT := 3; END_VAR END_FUNCTION"],
  ["Write(v := Result);", "FUNCTION Write VAR_IN_OUT v: INT; END_VAR v := 3; END_FUNCTION"],
  [
    "Forward(v := Result);",
    `FUNCTION Forward VAR_IN_OUT v: INT; END_VAR Write(v := v); END_FUNCTION
  `,
  ],
])("counts actual output and alias writes: %s", (body, helper) => {
  const helpers = helper.startsWith("FUNCTION Forward")
    ? [helper, "FUNCTION Write VAR_IN_OUT v: INT; END_VAR v := 3; END_FUNCTION"]
    : [helper];
  const { runtime, value } = setup([
    main("x := Result();"),
    `FUNCTION Result : INT ${body} END_FUNCTION`,
    ...helpers,
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("x")).toMatchObject({ value: 3 });
});

it("does not count merely passing the result to an in-out", () => {
  const { runtime } = setup([
    main("x := Result();"),
    "FUNCTION Result : INT Ignore(v := Result); END_FUNCTION",
    "FUNCTION Ignore VAR_IN_OUT v: INT; END_VAR END_FUNCTION",
  ]);
  runtime.step();
  expect(runtime.diagnostic?.code).toBe("runtime.result-not-assigned");
});

it.each([
  ["Copy(q => Result);", 8, 0],
  ["Write(v := Result.y);", 0, 9],
] as const)("tracks aggregate output copies and nested aliases: %s", (body, x, y) => {
  const { runtime, value } = setup(
    [
      main("p := Result();", "p: Point;"),
      `FUNCTION Result : Point ${body} END_FUNCTION`,
      "FUNCTION Copy VAR_OUTPUT q: Point; END_VAR q.x := 8; END_FUNCTION",
      "FUNCTION Write VAR_IN_OUT v: INT; END_VAR v := 9; END_FUNCTION",
    ],
    ["TYPE Point : STRUCT x,y: INT; END_STRUCT; END_TYPE"],
  );
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect([value("p.x"), value("p.y")]).toMatchObject([{ value: x }, { value: y }]);
});

it("tracks open-array and reference aliases without replacing the result cells", () => {
  const { runtime, value } = setup([
    main("a := ArrayResult(); r := ReferenceResult();", "a: ARRAY[1..2] OF LINT; r: REF_TO INT;"),
    "FUNCTION ArrayResult : ARRAY[1..2] OF LINT Fill(a := ArrayResult); END_FUNCTION",
    "FUNCTION Fill VAR_IN_OUT a: ARRAY[*] OF LINT; END_VAR a[2] := 42; END_FUNCTION",
    "FUNCTION ReferenceResult : REF_TO INT Clear(r := ReferenceResult); END_FUNCTION",
    "FUNCTION Clear VAR_IN_OUT r: REF_TO INT; END_VAR r := NULL; END_FUNCTION",
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("a[2]")).toMatchObject({ value: "42" });
});

it("reports an early RETURN's local span and does not copy the faulting call's outputs", () => {
  const { runtime, value } = setup([
    main("x := Result(q => y);", "x,y: INT;"),
    `FUNCTION Result : INT VAR_OUTPUT q: INT; END_VAR
     q := 7;
     RETURN;
     Result := 1;
     END_FUNCTION`,
  ]);
  runtime.step();
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.result-not-assigned",
    pou: "Result",
    span: { line: 3 },
  });
  expect(value("y")).toMatchObject({ value: 0 });
});

it.each(["stop", "warmRestart", "coldReset", "load", "emergencyStop"] as const)(
  "%s abandons an unassigned function without faulting or copying outputs",
  (command) => {
    const { runtime, value, ir } = setup([
      main("x := Result(q => y);", "x,y: INT;"),
      `FUNCTION Result : INT VAR_OUTPUT q: INT; END_VAR
       q := 7;
       Result := 1;
       END_FUNCTION`,
    ]);
    runtime.setBreakpoints([{ pou: "Result", line: 3 }]);
    runtime.scanOnce();
    expect(runtime.pauseLocation?.pou).toBe("Result");
    if (command === "load") runtime.load(ir);
    else if (command === "emergencyStop") runtime.setEmergencyStop(true);
    else runtime[command]();
    expect(runtime.diagnostic).toBeNull();
    expect(value("y")).toMatchObject({ value: 0 });
  },
);

it("preserves assignment tracking across a debugger pause and resume", () => {
  const { runtime, value } = setup([
    main("x := Result();"),
    `FUNCTION Result : INT
     Result := 5;
     RETURN;
     END_FUNCTION`,
  ]);
  runtime.setBreakpoints([{ pou: "Result", line: 3 }]);
  runtime.scanOnce();
  expect(runtime.pauseLocation?.pou).toBe("Result");
  runtime.resume();
  expect(runtime.diagnostic).toBeNull();
  expect(value("x")).toMatchObject({ value: 5 });
});

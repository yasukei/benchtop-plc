import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import type { RuntimeSnapshot, ScalarValue } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker, WATCHDOG_LIMIT } from "@benchtop-plc/runtime";

function setup(sources: string[]) {
  const compiled = compileProject(sources);
  expect(compiled.diagnostics).toEqual([]);
  const ir = compiled.ir!;
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(structuredClone(ir));
  const values = (snapshot: RuntimeSnapshot): Record<string, ScalarValue> =>
    Object.fromEntries(
      ir.variables.map((variable, index) => {
        const value = snapshot.variables[index]!;
        if (value.kind !== "scalar") throw new Error("Expected scalar");
        return [variable.name.replace(/^mainInstance\./, ""), value.value];
      }),
    );
  return { ir, runtime, values };
}

it("uses fresh inputs, VAR, outputs and result storage on every invocation", () => {
  const { runtime, values } = setup([
    `PROGRAM Main VAR a,b,c,out1,out2,out3: INT; END_VAR
     a := Fresh(N := 3, Q => out1);
     b := Fresh(N := 0, Q => out2);
     c := Fresh(Q => out3);
     END_PROGRAM`,
    `FUNCTION Fresh : INT
     VAR_INPUT N: INT := 2; END_VAR
     VAR counter: INT := 10; END_VAR
     VAR_OUTPUT Q: INT := 5; END_VAR
     IF N = 0 THEN RETURN; END_IF;
     counter := counter + N;
     Q := Q + counter;
     Fresh := Fresh + counter;
     END_FUNCTION`,
  ]);
  for (let scan = 0; scan < 3; scan++) {
    const snapshot = runtime.scanOnce();
    expect(values(snapshot)).toEqual({ a: 13, b: 0, c: 12, out1: 18, out2: 5, out3: 17 });
    expect(snapshot.variables).toHaveLength(6);
  }
});

it("returns from nested function bodies without leaving the caller", () => {
  const { runtime, values } = setup([
    `PROGRAM Main VAR x,y: INT; END_VAR x := Outer(); y := 99; END_PROGRAM`,
    `FUNCTION Outer : INT Outer := Inner() + 1; END_FUNCTION`,
    `FUNCTION Inner : INT WHILE TRUE DO Inner := 5; RETURN; END_WHILE; Inner := 100; END_FUNCTION`,
  ]);
  expect(values(runtime.scanOnce())).toEqual({ x: 6, y: 99 });
});

it("evaluates operands, positional arguments, and formal arguments left to right", () => {
  const { runtime, values } = setup([
    `PROGRAM Main VAR x: INT := 2; binary, positional, formal: INT; standard: TIME; END_VAR
     binary := Touch(Q => x) + x;
     x := 2;
     positional := Combine(Touch(Q => x), x);
     x := 2;
     formal := Combine(B := Touch(Q => x), A := x);
     x := 2;
     standard := ADD_TIME(IN2 := TouchTime(Q => x), IN1 := INT_TO_TIME(x));
     END_PROGRAM`,
    `FUNCTION Touch : INT VAR_OUTPUT Q: INT := 7; END_VAR Touch := 20; END_FUNCTION`,
    `FUNCTION TouchTime : TIME VAR_OUTPUT Q: INT := 7; END_VAR TouchTime := T#20s; END_FUNCTION`,
    `FUNCTION Combine : INT VAR_INPUT A,B: INT; END_VAR Combine := A * 10 + B; END_FUNCTION`,
  ]);
  expect(values(runtime.scanOnce())).toEqual({
    x: 7,
    binary: 27,
    positional: 207,
    formal: 90,
    standard: 20007,
  });
});

it("copies outputs after inputs are evaluated and the function returns", () => {
  const { runtime, values } = setup([
    `PROGRAM Main VAR x: INT := 2; result: INT; END_VAR result := Copy(A := x, Q => x) + x; END_PROGRAM`,
    `FUNCTION Copy : INT VAR_INPUT A: INT; END_VAR VAR_OUTPUT Q: INT; END_VAR Q := A + 3; Copy := A; END_FUNCTION`,
  ]);
  expect(values(runtime.scanOnce())).toEqual({ x: 5, result: 7 });
});

it("widens inputs, results and output assignments with exact long units", () => {
  const { runtime, values } = setup([
    `PROGRAM Main VAR timeValue: LTIME; output: LTIME; number: LINT; bits: LWORD; END_VAR
     timeValue := Duration(A := T#1s, Q => output);
     number := Widen(INT#-5);
     SetBits(Q => bits);
     END_PROGRAM`,
    `FUNCTION Duration : LTIME VAR_INPUT A: LTIME; END_VAR VAR_OUTPUT Q: TIME := T#2s; END_VAR Duration := A; END_FUNCTION`,
    `FUNCTION Widen : LINT VAR_INPUT A: LINT; END_VAR Widen := A; END_FUNCTION`,
    `FUNCTION SetBits VAR_OUTPUT Q: BYTE := 255; END_VAR END_FUNCTION`,
  ]);
  expect(values(runtime.scanOnce())).toEqual({
    timeValue: "1000000000",
    output: "2000000000",
    number: "-5",
    bits: "255",
  });
});

it("assigns outputs to bit and standard FB input targets", () => {
  const compiled = compileProject([
    `PROGRAM Main VAR bits: BYTE; timer: TON; END_VAR
     Enable(Q => bits.2); Enable(Q => timer.IN); END_PROGRAM`,
    `FUNCTION Enable VAR_OUTPUT Q: BOOL := TRUE; END_VAR END_FUNCTION`,
  ]);
  expect(compiled.diagnostics).toEqual([]);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(compiled.ir!);
  expect(runtime.scanOnce().variables).toMatchObject([
    { value: 4 },
    { kind: "functionBlock", inputs: [{ value: true }, { value: 0 }] },
  ]);
});

it("annotates statement results only in the PROGRAM and omits no-result calls", () => {
  const { runtime, ir } = setup([
    `PROGRAM Main
     F();
     G();
     END_PROGRAM`,
    `FUNCTION F : INT
     F := 42;
     END_FUNCTION`,
    `FUNCTION G
     VAR local: INT; END_VAR
     local := F();
     END_FUNCTION`,
  ]);
  const snapshot = runtime.scanOnce();
  expect(snapshot.variables).toEqual([]);
  expect(snapshot.annotations.Main).toEqual({
    2: [{ span: ir.programs[0]!.body[0]!.span, values: [{ dataType: "INT", value: 42 }] }],
  });
});

it.each([
  ["Broken := 1 / divisor;", "runtime.division-by-zero"],
  ["Broken := SQRT(REAL#-1.0);", "runtime.invalid-value"],
])("attributes faults inside nested functions to the failing POU", (body, code) => {
  const { runtime, ir } = setup([
    `PROGRAM Main VAR x: LREAL; END_VAR x := Outer(); END_PROGRAM`,
    `FUNCTION Outer : LREAL Outer := Broken(); END_FUNCTION`,
    `FUNCTION Broken : LREAL VAR divisor: INT; END_VAR ${body} END_FUNCTION`,
  ]);
  runtime.scanOnce();
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toMatchObject({
    code,
    pou: "Broken",
    span:
      ir.functions?.[1]?.body[0]?.kind === "assignment"
        ? ir.functions[1].body[0].value.span
        : undefined,
  });
  runtime.coldReset();
  expect(runtime.diagnostic).toBeNull();
  runtime.scanOnce();
  expect(runtime.diagnostic?.pou).toBe("Broken");
});

it("counts the watchdog per scan across all function invocations", () => {
  const { runtime } = setup([
    `PROGRAM Main Spin(); Spin(); END_PROGRAM`,
    `FUNCTION Spin VAR i: DINT; END_VAR
     FOR i := 1 TO 100001 DO END_FOR;
     END_FUNCTION`,
  ]);
  runtime.scanOnce();
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.watchdog",
    pou: "Spin",
    args: { limit: WATCHDOG_LIMIT },
  });
});

it("rounds typed REAL inputs, results and local arithmetic", () => {
  const { runtime, values } = setup([
    `PROGRAM Main VAR x: REAL; END_VAR x := Rounded(1.000000178813934326171874999); END_PROGRAM`,
    `FUNCTION Rounded : REAL VAR_INPUT A: REAL; END_VAR Rounded := A + REAL#1.0; END_FUNCTION`,
  ]);
  expect(values(runtime.scanOnce()).x).toBe(Math.fround(Math.fround(1.0000001192092896) + 1));
});

it("rejects invalid function-local initial values at load even when the function is uncalled", () => {
  const { ir, runtime } = setup([
    "PROGRAM Main END_PROGRAM",
    "FUNCTION Uncalled VAR n: LINT := 1; END_VAR END_FUNCTION",
  ]);
  const invalid = structuredClone(ir);
  Object.assign(invalid.functions![0]!.variables[0]!, { initialValue: "+1" });
  expect(() => runtime.load(invalid)).toThrow(RangeError);
  expect(runtime.scanOnce().variables).toEqual([]);
});

it("rejects invalid literals in unexecuted function branches at load", () => {
  const { ir, runtime } = setup([
    "PROGRAM Main END_PROGRAM",
    "FUNCTION Uncalled VAR n: LINT; END_VAR IF FALSE THEN n := LINT#1; END_IF; END_FUNCTION",
  ]);
  const invalid = structuredClone(ir);
  const conditional = invalid.functions![0]!.body[0]!;
  if (conditional.kind !== "if") throw new Error("Expected IF");
  const assignment = conditional.branches[0].body[0]!;
  if (assignment.kind !== "assignment") throw new Error("Expected assignment");
  Object.assign(assignment.value, { value: "+1" });
  expect(() => runtime.load(invalid)).toThrow(RangeError);
});

import { expect, it } from "vitest";
import { snapshotVariable } from "@benchtop-plc/core";
import { compileProject } from "@benchtop-plc/compiler";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

const counter = `FUNCTION_BLOCK Counter
VAR_INPUT Step: INT := 1; END_VAR
VAR n: INT; END_VAR
METHOD PUBLIC Increment
 VAR incrementLocal: INT := 10; END_VAR
 incrementLocal := incrementLocal + 1;
 n := n + Step + incrementLocal - 11;
END_METHOD
METHOD PUBLIC Reset n := 0; RETURN; n := 99; END_METHOD
METHOD PUBLIC Value : INT Value := THIS.n; END_METHOD
END_FUNCTION_BLOCK`;

function setup(sources: string[]) {
  const compiled = compileProject(sources);
  expect(compiled.diagnostics).toEqual([]);
  const ir = structuredClone(compiled.ir!);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  runtime.watch(ir.variables.map((_, i) => i));
  const scan = () => {
    const snapshot = runtime.scanOnce();
    return Object.fromEntries(
      ir.variables.map((v, i) => {
        const value = snapshot.variables[i]!;
        return [
          v.name.replace(/^mainInstance\./, ""),
          value.kind === "scalar" ? value.value : null,
        ];
      }),
    );
  };
  return { runtime, ir, scan, clock };
}

it("traces persistent counts, independent instances, fresh locals and last body inputs", () => {
  const { ir, scan } = setup([
    `PROGRAM Main VAR a,b: Counter; x,y: INT; END_VAR
  a(Step := 2); a.Increment(); a.Increment(); b.Reset(); b.Increment();
  x := a.Value(); y := b.Value(); END_PROGRAM`,
    counter,
  ]);
  expect(scan()).toMatchObject({ x: 4, y: 1, "A.N": 4, "B.N": 1 });
  expect(scan()).toMatchObject({ x: 8, y: 1, "A.N": 8, "B.N": 1 });
  expect(ir.variables.some((v) => /incrementLocal/i.test(v.name))).toBe(false);
  expect(ir.functionBlocks![0]!.methods).toHaveLength(3);
});

it("calls implicit methods and indexed receivers, binding in-outs and copying outputs", () => {
  const { scan } = setup([
    `PROGRAM Main VAR c: ARRAY[1..2] OF Ops; x,y,z: INT; END_VAR
  c[1](); c[2].Run(A := 3, B := x, Q => y); z := c[2].Get(); END_PROGRAM`,
    `FUNCTION_BLOCK Ops VAR total: INT; END_VAR
  METHOD PUBLIC Run
    VAR_INPUT A: INT := 2; END_VAR VAR_IN_OUT B: INT; END_VAR VAR_OUTPUT Q: INT := 1; END_VAR
    B := B + A; total := total + B; Q := Q + total;
  END_METHOD
  METHOD PUBLIC Get : INT Get := total; END_METHOD
  METHOD Init total := 7; END_METHOD
  THIS.Init();
  END_FUNCTION_BLOCK`,
  ]);
  expect(scan()).toMatchObject({ x: 3, y: 4, z: 3, "C[1].TOTAL": 7, "C[2].TOTAL": 3 });
  expect(scan()).toMatchObject({ x: 6, y: 10, z: 9 });
});

it("attributes method faults to the method, original POU span and receiver path", () => {
  const { runtime } = setup([
    `PROGRAM Main VAR c: Faulty; END_VAR c.Fail(); END_PROGRAM`,
    `FUNCTION_BLOCK Faulty METHOD PUBLIC Fail VAR x,y: INT; END_VAR x := 1 / y; END_METHOD END_FUNCTION_BLOCK`,
  ]);
  runtime.scanOnce();
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.division-by-zero",
    pou: "Faulty.Fail",
    instance: "mainInstance.C",
  });
});

it("counts method loops against the caller's shared watchdog budget", () => {
  const { runtime } = setup([
    "PROGRAM Main VAR c: Spinner; END_VAR c.Spin(); c.Spin(); END_PROGRAM",
    "FUNCTION_BLOCK Spinner METHOD PUBLIC Spin VAR i: DINT; END_VAR FOR i := 1 TO 100001 DO END_FOR; END_METHOD END_FUNCTION_BLOCK",
  ]);
  runtime.scanOnce();
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.watchdog",
    pou: "Spinner.Spin",
    instance: "mainInstance.C",
  });
});

it("uses THIS for nested and indexed receivers and reads instance externals", () => {
  const compiled = compileProject(
    [
      "PROGRAM Main VAR a: Owner; seen: INT; END_VAR a.Run(); seen := a.Value(); END_PROGRAM",
      `FUNCTION_BLOCK Owner VAR children: ARRAY[1..2] OF Counter; END_VAR VAR_EXTERNAL g: INT; END_VAR
    METHOD PUBLIC Run THIS.children[2].Increment(); g := g + 1; END_METHOD
    METHOD PUBLIC Value : INT Value := THIS.children[2].Value() + g; END_METHOD END_FUNCTION_BLOCK`,
      counter,
    ],
    [],
    `CONFIGURATION C VAR_GLOBAL g: INT; END_VAR RESOURCE R ON Cpu
  TASK T (INTERVAL := T#10ms, PRIORITY := 0); PROGRAM P WITH T : Main; END_RESOURCE END_CONFIGURATION`,
  );
  expect(compiled.diagnostics).toEqual([]);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(compiled.ir!);
  runtime.scanOnce();
  expect(runtime.diagnostic).toBeNull();
  const id = compiled.ir!.variables.findIndex((v) => v.name === "P.seen");
  expect(snapshotVariable(runtime.snapshot(), id)).toMatchObject({ value: 2 });
});

it("copies formal outputs to THIS members", () => {
  const { scan } = setup([
    "PROGRAM Main VAR c: Writer; x: INT; END_VAR c.Run(); x := c.Get(); END_PROGRAM",
    `FUNCTION_BLOCK Writer VAR n: INT; END_VAR
    METHOD PUBLIC Run SetValue(Q => THIS.n); END_METHOD
    METHOD SetValue VAR_OUTPUT Q: INT; END_VAR Q := 3; END_METHOD
    METHOD PUBLIC Get : INT Get := n; END_METHOD
    END_FUNCTION_BLOCK`,
  ]);
  expect(scan()).toMatchObject({ x: 3, "C.N": 3 });
});

it("selects a single overloaded instance variant across block bodies and methods", () => {
  const { runtime, scan, ir, clock } = setup([
    "PROGRAM Main VAR c: Timed; x: LTIME; END_VAR c.Run(); x := c.Elapsed(); END_PROGRAM",
    `FUNCTION_BLOCK Timed VAR timer: TON; END_VAR
    METHOD PUBLIC Run timer(IN := TRUE, PT := LTIME#1s); END_METHOD
    METHOD PUBLIC ShortRun timer(IN := TRUE, PT := T#2s); END_METHOD
    METHOD PUBLIC Elapsed : LTIME Elapsed := timer.ET; END_METHOD
    END_FUNCTION_BLOCK`,
  ]);
  expect(ir.variables.find((v) => /TIMER$/.test(v.key))).toMatchObject({ fbType: "TON_LTIME" });
  expect(scan()).toMatchObject({ x: "0" });
  clock.advance(10);
  expect(scan()).toMatchObject({ x: "10000000" });
  expect(runtime.diagnostic).toBeNull();
});

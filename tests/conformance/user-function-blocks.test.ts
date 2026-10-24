import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import type { RuntimeSnapshot } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function setup(sources: string[]) {
  const compiled = compileProject(sources);
  expect(compiled.diagnostics).toEqual([]);
  const ir = structuredClone(compiled.ir!);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  const id = (name: string) =>
    ir.variables.findIndex((variable) => variable.key === `MAININSTANCE.${name.toUpperCase()}`);
  const value = (snapshot: RuntimeSnapshot, name: string) => snapshot.variables[id(name)];
  const scalar = (snapshot: RuntimeSnapshot, name: string) => {
    const cell = value(snapshot, name);
    if (cell?.kind !== "scalar") throw new Error(`Expected scalar ${name}`);
    return cell.value;
  };
  return { ir, clock, runtime, id, value, scalar };
}

it("traces separate persistent inputs, outputs and locals, with fresh temporaries per call and scan", () => {
  const { runtime, scalar, ir } = setup([
    `PROGRAM Main
     VAR a,b : Latch; calls : INT; one,two,tempSeen : INT; END_VAR
     VAR_TEMP counter : INT := 10; END_VAR
     counter := counter + 1; tempSeen := counter;
     calls := calls + 1;
     IF calls = 1 THEN a(N := 2); b(N := 5); END_IF;
     a(Q => one); b(Q => two);
     END_PROGRAM`,
    `FUNCTION_BLOCK Latch
     VAR_INPUT N : INT := 1; END_VAR
     VAR_OUTPUT Q : INT; END_VAR
     VAR count : INT := 10; END_VAR
     VAR_TEMP temp : INT := 3; END_VAR
     temp := temp + 1; count := count + N; Q := count + temp;
     END_FUNCTION_BLOCK`,
  ]);
  const trace = [];
  for (let scan = 0; scan < 3; scan++) {
    const snapshot = runtime.scanOnce();
    trace.push([scalar(snapshot, "one"), scalar(snapshot, "two"), scalar(snapshot, "tempSeen")]);
    expect(runtime.state).toBe("STOP");
  }
  expect(trace).toEqual([
    [18, 24, 11],
    [20, 29, 11],
    [22, 34, 11],
  ]);
  expect(ir.variables.some((variable) => /TEMP$|COUNTER$/.test(variable.key))).toBe(false);
});

it("traces nested timers through STOP/RUN and cold reset, copying standard and user outputs", () => {
  const { clock, runtime, value, scalar } = setup([
    `PROGRAM Main VAR m1,m2 : Waiter; done : BOOL; elapsed : LTIME; END_VAR
     m1(enable := TRUE, Q => done, ET => elapsed); m2(enable := FALSE); END_PROGRAM`,
    `FUNCTION_BLOCK Waiter
     VAR_INPUT enable : BOOL; END_VAR VAR_OUTPUT Q : BOOL; ET : TIME; END_VAR
     VAR nested : Inner; END_VAR
     nested(enable := enable, Q => Q, ET => ET);
     END_FUNCTION_BLOCK`,
    `FUNCTION_BLOCK Inner
     VAR_INPUT enable : BOOL; END_VAR VAR_OUTPUT Q : BOOL; ET : TIME; END_VAR
     VAR delay : TON; edge : R_TRIG; END_VAR
     delay(IN := enable, PT := T#1s, Q => Q, ET => ET); edge(CLK := Q);
     END_FUNCTION_BLOCK`,
  ]);
  runtime.scanOnce();
  clock.advance(500);
  expect(scalar(runtime.scanOnce(), "elapsed")).toBe("500000000");
  runtime.run();
  runtime.stop();
  runtime.run();
  runtime.stop();
  clock.advance(500);
  let snapshot = runtime.scanOnce();
  expect(scalar(snapshot, "done")).toBe(true);
  expect(scalar(snapshot, "M2.Q")).toBe(false);
  expect(value(snapshot, "M1.NESTED.DELAY")).toMatchObject({
    kind: "functionBlock",
    outputs: [{ value: true }, { value: 1000 }],
  });
  runtime.coldReset();
  snapshot = runtime.scanOnce();
  expect(scalar(snapshot, "done")).toBe(false);
  expect(scalar(snapshot, "elapsed")).toBe("0");
  expect(value(snapshot, "M1.NESTED.EDGE")).toMatchObject({ outputs: [{ value: false }] });
  clock.advance(1000);
  expect(scalar(runtime.scanOnce(), "done")).toBe(true);
});

it("applies writes and force stages to the same scalar cells used by instances", () => {
  const { runtime, scalar, id } = setup([
    `PROGRAM Main VAR m1 : Latch; seen : INT; END_VAR m1(Q => seen); END_PROGRAM`,
    `FUNCTION_BLOCK Latch VAR_OUTPUT Q : INT; END_VAR VAR running : INT; END_VAR
     running := running + 1; Q := running; END_FUNCTION_BLOCK`,
  ]);
  runtime.write(id("M1.RUNNING"), { dataType: "INT", value: 10 });
  expect(scalar(runtime.scanOnce(), "seen")).toBe(11);
  runtime.force(id("M1.RUNNING"), { dataType: "INT", value: 20 });
  const snapshot = runtime.scanOnce();
  expect(scalar(snapshot, "seen")).toBe(21);
  expect(scalar(snapshot, "M1.RUNNING")).toBe(20);
  runtime.force(id("M1.RUNNING"), null);
  expect(scalar(runtime.scanOnce(), "seen")).toBe(21);
});

it("widens input/output durations, handles public input assignment and RETURN, and annotates only PROGRAM calls", () => {
  const { runtime, scalar } = setup([
    `PROGRAM Main VAR inst : Duration; elapsed : LTIME; END_VAR
     inst.t := T#1s; inst(Q => elapsed); END_PROGRAM`,
    `FUNCTION_BLOCK Duration VAR_INPUT t : LTIME; END_VAR VAR_OUTPUT Q : TIME; END_VAR
     Q := LTIME_TO_TIME(t); RETURN; Q := T#9s; END_FUNCTION_BLOCK`,
  ]);
  const snapshot = runtime.scanOnce();
  expect(scalar(snapshot, "elapsed")).toBe("1000000000");
  expect(Object.values(snapshot.annotations.Main ?? {}).flat()).toHaveLength(2);
  expect(
    Object.values(snapshot.annotations.Main ?? {})
      .flat()
      .at(-1)?.values,
  ).toEqual([{ dataType: "TIME", value: 1000 }]);
});

it("names the faulting POU and nested instance, keeping all persistent state in FAULT", () => {
  const { runtime, scalar } = setup([
    `PROGRAM Main VAR m1 : Outer; END_VAR m1(); END_PROGRAM`,
    `FUNCTION_BLOCK Outer VAR delay : Broken; END_VAR delay(); END_FUNCTION_BLOCK`,
    `FUNCTION_BLOCK Broken VAR count : INT := 5; zero : INT; END_VAR count := count + 1; count := count / zero; END_FUNCTION_BLOCK`,
  ]);
  const snapshot = runtime.scanOnce();
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.division-by-zero",
    pou: "Broken",
    instance: "mainInstance.M1.DELAY",
  });
  expect(scalar(snapshot, "M1.DELAY.COUNT")).toBe(6);
  runtime.stop();
  expect(scalar(runtime.scanOnce(), "M1.DELAY.COUNT")).toBe(6);
  runtime.coldReset();
  expect(scalar(runtime.snapshot(), "M1.DELAY.COUNT")).toBe(5);
});

it("copies outputs in binding order to aliased variables, bits and user/standard input ports", () => {
  const { runtime, scalar, value } = setup([
    `PROGRAM Main VAR a : Outputs; b : Receiver; timer : TON; bits : BYTE; x : LINT; END_VAR
     a(first => x, second => x, flag => bits.3);
     a(flag => timer.IN); a(flag => b.enabled);
     END_PROGRAM`,
    `FUNCTION_BLOCK Outputs
     VAR_OUTPUT first : INT := 1; second : INT := 2; flag : BOOL := TRUE; END_VAR
     END_FUNCTION_BLOCK`,
    `FUNCTION_BLOCK Receiver VAR_INPUT enabled : BOOL; END_VAR END_FUNCTION_BLOCK`,
  ]);
  const snapshot = runtime.scanOnce();
  expect(runtime.diagnostic).toBeNull();
  expect(scalar(snapshot, "x")).toBe("2");
  expect(scalar(snapshot, "bits")).toBe(8);
  expect(scalar(snapshot, "B.ENABLED")).toBe(true);
  expect(value(snapshot, "timer")).toMatchObject({
    inputs: [
      { dataType: "BOOL", value: true },
      { dataType: "TIME", value: 0 },
    ],
  });
});

it("widens user block input durations and transports long output annotations as strings", () => {
  const { runtime, scalar } = setup([
    `PROGRAM Main VAR inst : Duration; elapsed : LTIME; END_VAR inst(t := T#1s, Q => elapsed); END_PROGRAM`,
    `FUNCTION_BLOCK Duration VAR_INPUT t : LTIME; END_VAR VAR_OUTPUT Q : LTIME; END_VAR Q := t; END_FUNCTION_BLOCK`,
  ]);
  const snapshot = runtime.scanOnce();
  expect(scalar(snapshot, "elapsed")).toBe("1000000000");
  expect(Object.values(snapshot.annotations.Main ?? {}).flat()[0]?.values).toEqual([
    { dataType: "LTIME", value: "1000000000" },
  ]);
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
});

it("annotates user block outputs in declaration order despite reversed output bindings", () => {
  const { runtime, scalar } = setup([
    `PROGRAM Main
     VAR inst : Outputs; number : INT; flag : BOOL; END_VAR
     inst(second => flag, first => number);
     END_PROGRAM`,
    `FUNCTION_BLOCK Outputs
     VAR_OUTPUT first : INT; second : BOOL; END_VAR
     first := 42; second := TRUE;
     END_FUNCTION_BLOCK`,
  ]);
  const snapshot = runtime.scanOnce();
  expect(runtime.diagnostic).toBeNull();
  expect(scalar(snapshot, "number")).toBe(42);
  expect(scalar(snapshot, "flag")).toBe(true);
  expect(Object.values(snapshot.annotations.Main ?? {}).flat()).toEqual([
    expect.objectContaining({
      span: expect.objectContaining({ line: 3 }),
      values: [
        { dataType: "INT", value: 42 },
        { dataType: "BOOL", value: true },
      ],
    }),
  ]);
});

it("shares the scan watchdog across several block invocations", () => {
  const { runtime } = setup([
    `PROGRAM Main VAR first,second : Work; END_VAR first(); second(); END_PROGRAM`,
    `FUNCTION_BLOCK Work VAR_TEMP n : DINT; END_VAR FOR n := 1 TO 120000 DO END_FOR; END_FUNCTION_BLOCK`,
  ]);
  runtime.scanOnce();
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.watchdog",
    pou: "Work",
    instance: "mainInstance.SECOND",
  });
});

it("reports function faults without the calling block's instance path", () => {
  const { runtime } = setup([
    `PROGRAM Main VAR m1 : B; END_VAR m1(); END_PROGRAM`,
    `FUNCTION F : INT VAR_INPUT d : INT; END_VAR F := Divide(d); END_FUNCTION`,
    `FUNCTION Divide : INT VAR_INPUT d : INT; END_VAR Divide := 1 / d; END_FUNCTION`,
    `FUNCTION_BLOCK B VAR_OUTPUT Q : INT; END_VAR Q := F(d := 0); END_FUNCTION_BLOCK`,
  ]);
  runtime.scanOnce();
  expect(runtime.diagnostic).toMatchObject({ code: "runtime.division-by-zero", pou: "Divide" });
  expect(runtime.diagnostic).toHaveProperty("instance", "mainInstance");
});

it("restores a block's instance path after a successful function call", () => {
  const { runtime } = setup([
    `PROGRAM Main VAR m1 : B; END_VAR m1(); END_PROGRAM`,
    `FUNCTION F : INT F := 5; END_FUNCTION`,
    `FUNCTION_BLOCK B VAR Q,zero : INT; END_VAR Q := F(); Q := Q / zero; END_FUNCTION_BLOCK`,
  ]);
  runtime.scanOnce();
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.division-by-zero",
    pou: "B",
    instance: "mainInstance.M1",
  });
});

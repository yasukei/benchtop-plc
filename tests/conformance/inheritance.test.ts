import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function setup(sources: string[], configuration?: string) {
  const compiled = compileProject(sources, [], configuration);
  expect(compiled.diagnostics).toEqual([]);
  const ir = structuredClone(compiled.ir!);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  runtime.watch(ir.variables.map((_, id) => id));
  const id = (name: string) => ir.variables.findIndex((v) => v.key === name.toUpperCase());
  const value = (name: string) => snapshotVariable(runtime.snapshot(), id(name));
  return { runtime, ir, value, id };
}

const motor = `CLASS Motor
VAR PUBLIC Speed: INT := 1; END_VAR
VAR PRIVATE checks: INT; END_VAR
METHOD PUBLIC Start : INT
 Start := THIS.Check(Step := 2);
END_METHOD
METHOD PROTECTED Check : INT
 VAR_INPUT Step: INT; END_VAR
 checks := checks + 1;
 Speed := Speed + Step; Check := Speed;
END_METHOD
END_CLASS`;
const servo = `CLASS ServoMotor EXTENDS Motor
VAR extra: INT := 3; END_VAR
METHOD PROTECTED OVERRIDE Check : INT
 VAR_INPUT Step: INT; END_VAR
 VAR fresh: INT := 1; END_VAR
 fresh := fresh + 1;
 Check := SUPER.Check(Step := Step + extra) + fresh;
END_METHOD
END_CLASS`;

it("traces Motor.Start dynamically dispatching THIS.Check and a static SUPER.Check", () => {
  const { runtime, value, ir } = setup([
    `PROGRAM Main VAR baseMotor: Motor; servos: ARRAY[1..2] OF ServoMotor; first,second: INT; END_VAR
    first := baseMotor.Start(); second := servos[2].Start(); END_PROGRAM`,
    motor,
    servo,
  ]);
  expect(ir.instances?.map((i) => i.block)).toEqual([0, 1, 1]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("mainInstance.first")).toMatchObject({ value: 3 });
  expect(value("mainInstance.second")).toMatchObject({ value: 8 });
  expect(value("mainInstance.servos[2].Speed")).toMatchObject({ value: 6 });
  expect(value("mainInstance.servos[2].checks")).toMatchObject({ value: 1 });
  expect(value("mainInstance.servos[1].checks")).toMatchObject({ value: 0 });
  runtime.step();
  expect(value("mainInstance.second")).toMatchObject({ value: 13 });
  expect(value("mainInstance.servos[2].extra")).toMatchObject({ value: 3 });
});

it("traces an override of Start calling SUPER.Start with implicit virtual calls", () => {
  const { runtime, value } = setup([
    "PROGRAM Main VAR m: BoostMotor; seen: INT; END_VAR seen := m.Start(); END_PROGRAM",
    motor.replace("THIS.Check", "Check"),
    servo,
    `CLASS BoostMotor EXTENDS ServoMotor
    VAR marker: INT := 4; END_VAR
    METHOD PUBLIC FINAL OVERRIDE Start : INT
      Start := SUPER.Start() + marker;
    END_METHOD END_CLASS`,
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("mainInstance.seen")).toMatchObject({ value: 12 });
  expect(value("mainInstance.m.Speed")).toMatchObject({ value: 6 });
});

it("dispatches input, output and in-out parameters across different receiver layouts", () => {
  const { runtime, value } = setup([
    "PROGRAM Main VAR d: Derived; resultValue: INT; END_VAR d.Run(Q => resultValue); END_PROGRAM",
    `CLASS Base VAR baseValue: INT := 2; END_VAR
    METHOD PUBLIC Run VAR_OUTPUT Q: INT; END_VAR VAR n: INT := 3; END_VAR
      THIS.Change(A := 4, V := n, Q => Q); Q := Q + n;
    END_METHOD
    METHOD Change VAR_INPUT A: INT; END_VAR VAR_IN_OUT V: INT; END_VAR VAR_OUTPUT Q: INT; END_VAR
      V := V + A; Q := baseValue;
    END_METHOD END_CLASS`,
    `CLASS Derived EXTENDS Base VAR extra: INT := 5; END_VAR
    METHOD OVERRIDE Change VAR_INPUT A: INT; END_VAR VAR_IN_OUT V: INT; END_VAR VAR_OUTPUT Q: INT; END_VAR
      SUPER.Change(A := A, V := V, Q => Q); V := V + extra; Q := Q + extra;
    END_METHOD END_CLASS`,
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("mainInstance.resultValue")).toMatchObject({ value: 19 });
  expect(value("mainInstance.d.extra")).toMatchObject({ value: 5 });
});

it("traces SUPER bodies, comments-only inheritance and RETURN replacement through a chain", () => {
  const { runtime, value } = setup([
    `PROGRAM Main VAR inherited: Empty; explicitCall: Derived; skipped: Suppressed; chained: Leaf; aliasValue: INT; END_VAR
    inherited(Step := 2, Shared := aliasValue); explicitCall(Step := 3, Shared := aliasValue);
    skipped(Step := 4, Shared := aliasValue); chained(Step := 5, Shared := aliasValue); END_PROGRAM`,
    `FUNCTION_BLOCK Base
    VAR_INPUT Step: INT := 1; END_VAR
    VAR_OUTPUT Count: INT := 10; END_VAR
    VAR_IN_OUT Shared: INT; END_VAR
    VAR PRIVATE hidden: INT; END_VAR
    VAR_TEMP scratch: INT := 2; END_VAR
    Count := Count + Step + scratch; hidden := hidden + 1; Shared := Shared + 1;
    END_FUNCTION_BLOCK`,
    "FUNCTION_BLOCK Empty EXTENDS Base (* no statements *) END_FUNCTION_BLOCK",
    "FUNCTION_BLOCK Derived EXTENDS Base VAR extra: INT := 3; END_VAR SUPER(); Count := Count + extra; END_FUNCTION_BLOCK",
    "FUNCTION_BLOCK Suppressed EXTENDS Base RETURN; END_FUNCTION_BLOCK",
    "FUNCTION_BLOCK Leaf EXTENDS Empty SUPER(); END_FUNCTION_BLOCK",
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  for (const [instance, count] of [
    ["inherited", 14],
    ["explicitCall", 18],
    ["skipped", 10],
    ["chained", 17],
  ] as const)
    expect(value(`mainInstance.${instance}.Count`)).toMatchObject({ value: count });
  expect(value("mainInstance.aliasValue")).toMatchObject({ value: 3 });
  expect(value("mainInstance.inherited.hidden")).toMatchObject({ value: 1 });
  runtime.step();
  expect(value("mainInstance.inherited.Count")).toMatchObject({ value: 18 });
});

it("initializes inherited private constants in their declaring context and monitors base first", () => {
  const { runtime, ir, value, id } = setup([
    "PROGRAM Main VAR d: Derived; END_VAR END_PROGRAM",
    "CLASS Base VAR PRIVATE CONSTANT seed: INT := 7; END_VAR VAR PRIVATE hidden: INT := seed; END_VAR END_CLASS",
    "CLASS Derived EXTENDS Base VAR PUBLIC own: INT := 3; END_VAR END_CLASS",
  ]);
  expect(ir.variables.map((v) => v.name)).toEqual(["mainInstance.D.HIDDEN", "mainInstance.D.OWN"]);
  expect(value("mainInstance.d.hidden")).toMatchObject({ value: 7 });
  runtime.write(id("mainInstance.d.hidden"), { dataType: "INT", value: 8 });
  runtime.step();
  expect(value("mainInstance.d.hidden")).toMatchObject({ value: 8 });
  runtime.force(id("mainInstance.d.hidden"), { dataType: "INT", value: 9 });
  runtime.step();
  expect(value("mainInstance.d.hidden")).toMatchObject({ value: 9 });
});

it("retains inherited storage according to instance and member qualifiers on warm restart and reload", () => {
  const sources = [
    `PROGRAM Main VAR RETAIN kept: Derived; END_VAR VAR normal: Derived; END_VAR kept(); normal(); END_PROGRAM`,
    `FUNCTION_BLOCK Base VAR count: INT := 1; END_VAR VAR RETAIN retained: INT := 2; END_VAR
    VAR NON_RETAIN reset: INT := 3; END_VAR count := count + 1; retained := retained + 1; reset := reset + 1; END_FUNCTION_BLOCK`,
    "FUNCTION_BLOCK Derived EXTENDS Base VAR own: INT := 4; END_VAR SUPER(); own := own + 1; END_FUNCTION_BLOCK",
  ];
  const { runtime, value } = setup(sources);
  runtime.step();
  runtime.step();
  runtime.warmRestart();
  for (const [path, expected] of Object.entries({
    "kept.count": 3,
    "kept.retained": 4,
    "kept.reset": 3,
    "kept.own": 6,
    "normal.count": 1,
    "normal.retained": 4,
    "normal.reset": 3,
    "normal.own": 4,
  }))
    expect(value(`mainInstance.${path}`)).toMatchObject({ value: expected });
  const restored = setup(sources);
  expect(
    restored.runtime.restoreRetentive(JSON.parse(JSON.stringify(runtime.retentiveRecords()))),
  ).toEqual([]);
  expect(restored.value("mainInstance.kept.count")).toMatchObject({ value: 3 });
  expect(restored.value("mainInstance.normal.retained")).toMatchObject({ value: 4 });
  runtime.coldReset();
  expect(value("mainInstance.kept.count")).toMatchObject({ value: 1 });
});

it.each([false, true])(
  "attributes an inherited method fault to its declaring source (SUPER: %s)",
  (superCall) => {
    const { runtime } = setup([
      "PROGRAM Main VAR d: Derived; END_VAR d.Fail(); END_PROGRAM",
      "CLASS Base METHOD PUBLIC Fail VAR x,y: INT; END_VAR x := 1 / y; END_METHOD END_CLASS",
      `CLASS Derived EXTENDS Base ${superCall ? "METHOD PUBLIC OVERRIDE Fail SUPER.Fail(); END_METHOD" : ""} END_CLASS`,
    ]);
    runtime.step();
    expect(runtime.diagnostic).toMatchObject({
      code: "runtime.division-by-zero",
      pou: "Base.Fail",
      instance: "mainInstance.D",
    });
  },
);

it.each(["(* inherited *)", "SUPER();"])(
  "attributes an inherited body fault to the declaring source: %s",
  (body) => {
    const { runtime } = setup([
      "PROGRAM Main VAR d: Derived; END_VAR d(); END_PROGRAM",
      "FUNCTION_BLOCK Base VAR x,y: INT; END_VAR x := 1 / y; END_FUNCTION_BLOCK",
      `FUNCTION_BLOCK Derived EXTENDS Base ${body} END_FUNCTION_BLOCK`,
    ]);
    runtime.step();
    expect(runtime.diagnostic).toMatchObject({
      code: "runtime.division-by-zero",
      pou: "Base",
      instance: "mainInstance.D",
    });
  },
);

it("implements inherited abstract methods without instantiating the abstract definitions", () => {
  const { runtime, value } = setup([
    "PROGRAM Main VAR d: Derived; seen: INT; END_VAR seen := d.Run(); END_PROGRAM",
    "CLASS ABSTRACT Base METHOD PUBLIC Run: INT Run := Check(); END_METHOD METHOD ABSTRACT Check: INT END_METHOD END_CLASS",
    "CLASS ABSTRACT Middle EXTENDS Base END_CLASS",
    "CLASS FINAL Derived EXTENDS Middle VAR n: INT := 8; END_VAR METHOD FINAL OVERRIDE Check: INT Check := n; END_METHOD END_CLASS",
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("mainInstance.seen")).toMatchObject({ value: 8 });
});

it.each(["CLASS", "FUNCTION_BLOCK"])(
  "dispatches %s inputs when an override declares locals before its parameters",
  (kind) => {
    const { runtime, value } = setup([
      "PROGRAM Main VAR b: Base; d: Derived; rb,rd: INT; END_VAR rb := b.Run(); rd := d.Run(); END_PROGRAM",
      `${kind} Base
      METHOD PUBLIC Run : INT Run := THIS.Twice(A := 5); END_METHOD
      METHOD PUBLIC Twice : INT VAR_INPUT A: INT; END_VAR Twice := A * 2; END_METHOD
      END_${kind}`,
      `${kind} Derived EXTENDS Base
      METHOD PUBLIC OVERRIDE Twice : INT
        VAR tmp: INT := 100; END_VAR
        VAR_INPUT A: INT; END_VAR
        Twice := A * 3;
      END_METHOD END_${kind}`,
    ]);
    runtime.step();
    expect(runtime.diagnostic).toBeNull();
    expect(value("mainInstance.rb")).toMatchObject({ value: 10 });
    expect(value("mainInstance.rd")).toMatchObject({ value: 15 });
  },
);

it("maps every parameter section through overrides with different locals and receiver prefixes", () => {
  const { runtime, value } = setup([
    "PROGRAM Main VAR b: Base; d: Derived; rb,rd: INT; END_VAR rb := b.Run(); rd := d.Run(); END_PROGRAM",
    `CLASS Base
    METHOD PUBLIC Run : INT
      VAR local: INT := 3; outValue: INT; END_VAR
      THIS.Change(A := 5, V := local, Q => outValue); Run := local + outValue;
    END_METHOD
    METHOD Change
      VAR_INPUT A: INT; END_VAR
      VAR baseScratch: INT := 100; END_VAR
      VAR_OUTPUT Q: INT; END_VAR
      VAR_IN_OUT V: INT; END_VAR
      Q := A * 2; V := V + 1;
    END_METHOD END_CLASS`,
    `CLASS Derived EXTENDS Base VAR extra: INT := 4; END_VAR
    METHOD OVERRIDE Change
      VAR tmp: INT := 40; END_VAR
      VAR_INPUT A: INT; END_VAR
      VAR_OUTPUT Q: INT; END_VAR
      VAR tmp2: INT := 10; END_VAR
      VAR_IN_OUT V: INT; END_VAR
      SUPER.Change(A := A, V := V, Q => Q); Q := Q + tmp + tmp2; V := V + extra;
    END_METHOD END_CLASS`,
  ]);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  expect(value("mainInstance.rb")).toMatchObject({ value: 14 });
  expect(value("mainInstance.rd")).toMatchObject({ value: 68 });
  expect(value("mainInstance.d.extra")).toMatchObject({ value: 4 });
});

import { expect, it } from "vitest";
import { compileProject } from "./index.js";

const motor = `FUNCTION_BLOCK Motor
VAR_INPUT step: INT; END_VAR VAR_OUTPUT count: INT; END_VAR
VAR PUBLIC speed: INT; END_VAR VAR secret: INT; END_VAR
METHOD Hidden END_METHOD
METHOD PUBLIC Start count := count + step; END_METHOD
METHOD PUBLIC Value : INT Value := count; END_METHOD
count := count + step;
END_FUNCTION_BLOCK`;
const servo = `FUNCTION_BLOCK Servo EXTENDS Motor
METHOD PUBLIC OVERRIDE Value : INT Value := 99; END_METHOD
count := count + step * 2;
END_FUNCTION_BLOCK`;
const face = "INTERFACE IDrive METHOD Start END_METHOD METHOD Value : INT END_METHOD END_INTERFACE";
function compile(body: string, declarations = "", extra: string[] = [], types: string[] = []) {
  return compileProject(
    [
      `PROGRAM Main VAR m: Motor; s: Servo; r: REF_TO Motor; d: REF_TO Servo; b: BOOL; ${declarations} END_VAR ${body} END_PROGRAM`,
      motor,
      servo,
      ...extra,
    ],
    types,
  );
}

it("lowers references to user blocks and classes, aliases, members, methods and body calls", () => {
  const result = compile(
    "r := REF(s); d := REF(s); r := d; r^.speed := 4; r^.Start(); r^(step := 2); b := r = d; b := d <> r; c := REF(v); c^.Open();",
    "v: Valve; c: ValveRef;",
    ["CLASS Valve METHOD PUBLIC Open END_METHOD END_CLASS"],
    ["TYPE ValveRef : REF_TO Valve; END_TYPE"],
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.ir?.programs[0]!.body[5]).toMatchObject({
    kind: "userFbCall",
    instance: { kind: "dereference" },
  });
  expect(result.ir?.variables.filter((v) => v.kind === "reference")).toHaveLength(3);
  expect(() => JSON.stringify(result.ir)).not.toThrow();
});

it.each([
  ["d := r;", "", "type.assign-mismatch"],
  ["b := r = unrelated;", "unrelated: REF_TO Other;", "type.operand-mismatch"],
  ["r^.secret := 1;", "", "fb.unknown-member"],
  ["r^.count := 1;", "", "fb.output-not-writable"],
  ["r^.Hidden();", "", "access.hidden"],
  ["r ?= 1;", "", "interface.assignment-attempt"],
  ["r ?= scalar;", "scalar: REF_TO INT;", "interface.assignment-attempt"],
  ["scalar ?= r;", "scalar: REF_TO INT;", "interface.assignment-attempt"],
  ["r ?= m;", "", "fb.instance-as-value"],
  ["v^();", "v: REF_TO Valve;", "class.not-callable"],
])("rejects invalid instance reference use: %s", (body, declarations, code) => {
  const result = compile(body, declarations, ["CLASS Other END_CLASS", "CLASS Valve END_CLASS"]);
  expect(result.diagnostics.map((d) => d.code)).toContain(code);
  expect(result.ir).toBeUndefined();
});

it.each(["TON", "IDrive", "ARRAY[1..2] OF TON"])("rejects REF_TO %s", (target) => {
  expect(
    compile("", `invalid: REF_TO ${target};`, [face]).diagnostics.map((d) => d.code),
  ).toContain("type.invalid-reference-target");
});

it("accepts reference casts and conversions to implementing interfaces", () => {
  const result = compileProject([
    `PROGRAM Main VAR s: Servo; r: REF_TO Motor; d: REF_TO Servo; a: IDrive; END_VAR
      r := REF(s); d ?= r; a := r^; r ?= a; a ?= r; d ?= NULL; END_PROGRAM`,
    motor.replace("FUNCTION_BLOCK Motor", "FUNCTION_BLOCK Motor IMPLEMENTS IDrive"),
    servo,
    face,
  ]);
  expect(result.diagnostics).toEqual([]);
});

it("allows REF of persistent instance members, array elements, THIS and globals", () => {
  const result = compileProject(
    [
      `PROGRAM Main VAR ms: ARRAY[1..2] OF Motor; h: Holder; r: REF_TO Motor; END_VAR
      r := REF(ms[2]); r := h.Self(); r := h.Child(); END_PROGRAM`,
      motor,
      `CLASS Holder VAR childInstance: Motor; END_VAR VAR_EXTERNAL shared: Motor; END_VAR
      METHOD PUBLIC Self : REF_TO Motor Self := REF(shared); END_METHOD
      METHOD PUBLIC Child : REF_TO Motor Child := REF(childInstance); END_METHOD
      METHOD PUBLIC Identity : REF_TO Holder Identity := REF(THIS); END_METHOD END_CLASS`,
    ],
    [],
    `CONFIGURATION Config VAR_GLOBAL shared: Motor; END_VAR
    RESOURCE Res ON BENCHTOP TASK Cycle(INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM mainInstance WITH Cycle: Main; END_RESOURCE END_CONFIGURATION`,
  );
  expect(result.diagnostics).toEqual([]);
});

it.each([
  "FUNCTION Local : REF_TO INT VAR x: INT; END_VAR Local := REF(x); END_FUNCTION",
  "FUNCTION F : REF_TO Motor VAR_INPUT r: REF_TO Motor; END_VAR F := REF(r); END_FUNCTION",
  "CLASS C METHOD PUBLIC Run VAR localValue: INT; r: REF_TO INT; END_VAR r := REF(localValue); END_METHOD END_CLASS",
  "FUNCTION_BLOCK B VAR_TEMP temp: INT; END_VAR VAR r: REF_TO INT; END_VAR r := REF(THIS.temp); END_FUNCTION_BLOCK",
  "FUNCTION_BLOCK B VAR_TEMP temp: INT; END_VAR VAR r: REF_TO INT; END_VAR r := REF(temp); END_FUNCTION_BLOCK",
  "FUNCTION_BLOCK B VAR_IN_OUT io: INT; END_VAR VAR r: REF_TO INT; END_VAR r := REF(io); END_FUNCTION_BLOCK",
])("rejects targets that lack persistent lifetime", (source) => {
  expect(compile("", "", [source]).diagnostics.map((d) => d.code)).toContain(
    "type.invalid-reference-target",
  );
});

it("rejects dynamic method recursion through a derived override", () => {
  const result = compileProject([
    "PROGRAM Main END_PROGRAM",
    "CLASS Base METHOD PUBLIC Run END_METHOD END_CLASS",
    "CLASS Derived EXTENDS Base METHOD PUBLIC OVERRIDE Run VAR r: REF_TO Base; END_VAR r^.Run(); END_METHOD END_CLASS",
  ]);
  expect(result.diagnostics.map((d) => d.code)).toContain("pou.recursion");
});

it("rejects dynamic body recursion through a derived implementation", () => {
  const result = compileProject([
    "PROGRAM Main END_PROGRAM",
    "FUNCTION_BLOCK Base END_FUNCTION_BLOCK",
    "FUNCTION_BLOCK Derived EXTENDS Base VAR r: REF_TO Base; END_VAR r^(); END_FUNCTION_BLOCK",
  ]);
  expect(result.diagnostics.map((d) => d.code)).toContain("pou.recursion");
});

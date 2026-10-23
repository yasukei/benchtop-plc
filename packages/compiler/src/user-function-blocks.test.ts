import { expect, it } from "vitest";
import { compileProject } from "./index.js";

const block = `FUNCTION_BLOCK Latch
VAR_INPUT enable : BOOL; END_VAR
VAR_OUTPUT Q : BOOL; END_VAR
VAR running : BOOL; delay : TON; END_VAR
VAR_TEMP scratch : INT := 3; END_VAR
running := running OR enable; Q := running;
END_FUNCTION_BLOCK`;
const main = (body = "", declarations = "m1,m2 : Latch; x : BOOL;") =>
  `PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`;

it("shares block code and allocates dotted scalar and standard FB identities", () => {
  const result = compileProject([main("m1(enable := TRUE, Q => x); m2();"), block]);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir?.functionBlocks).toHaveLength(1);
  expect(result.ir?.instances?.map((instance) => instance.path)).toEqual(["M1", "M2"]);
  expect(result.ir?.variables.map((variable) => variable.name)).toEqual([
    "M1.ENABLE",
    "M1.Q",
    "M1.RUNNING",
    "M1.DELAY",
    "M2.ENABLE",
    "M2.Q",
    "M2.RUNNING",
    "M2.DELAY",
    "x",
  ]);
  expect(JSON.parse(JSON.stringify(result.ir))).toEqual(result.ir);
});

it.each([
  ["x := m1.running;", "fb.unknown-member"],
  ["x := m1.scratch;", "fb.unknown-member"],
  ["m1.running := TRUE;", "fb.unknown-member"],
  ["m1.Q := TRUE;", "fb.output-not-writable"],
  ["m1(Q := TRUE);", "fb.output-not-writable"],
  ["m1(enable => x);", "call.invalid-parameter"],
  ["m1(Q => x, Q => x);", "call.invalid-parameter"],
  ["m1(enable := TRUE, enable := FALSE);", "fb.duplicate-input"],
  ["m1(missing := TRUE);", "fb.unknown-member"],
  ["m1(TRUE);", "fb.unsupported-call"],
  ["x := m1();", "fb.call-in-expression"],
  ["x := m1;", "fb.instance-as-value"],
  ["x := m1.delay.Q;", "fb.unknown-member"],
])("checks block access and calls: %s", (body, code) => {
  const result = compileProject([main(body), block]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code, pou: "Main", sourceIndex: 0 }),
  );
});

it.each(["TON", "Latch"])("rejects %s instances outside VAR", (type) => {
  for (const section of ["VAR_TEMP", "VAR_INPUT", "VAR_OUTPUT"]) {
    const result = compileProject([
      `PROGRAM Main ${section} inst : ${type}; END_VAR END_PROGRAM`,
      block,
    ]);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.map((item) => item.code)).toContain("fb.invalid-instance-section");
  }
});

it.each([
  ["FUNCTION F VAR inst : Latch; END_VAR END_FUNCTION", "pou.function-block-in-function"],
  ["FUNCTION F Latch(); END_FUNCTION", "call.unknown-function"],
  ["FUNCTION_BLOCK Bad VAR pin AT %IX0.0 : BOOL; END_VAR END_FUNCTION_BLOCK", "pou.direct-address"],
  ["FUNCTION_BLOCK Bad VAR inst : Latch := 1; END_VAR END_FUNCTION_BLOCK", "decl.fb-initializer"],
])("rejects unsupported block declarations: %s", (source, code) => {
  const result = compileProject([main(), block, source]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.map((item) => item.code)).toContain(code);
});

it.each([
  ["FUNCTION_BLOCK A VAR inst : A; END_VAR END_FUNCTION_BLOCK"],
  [
    "FUNCTION_BLOCK A VAR inst : B; END_VAR END_FUNCTION_BLOCK",
    "FUNCTION_BLOCK B VAR inst : A; END_VAR END_FUNCTION_BLOCK",
  ],
])("rejects containment cycles even when unreachable", (...blocks) => {
  const result = compileProject(["PROGRAM Main END_PROGRAM", ...blocks]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "pou.recursion", span: expect.any(Object) }),
  );
});

it("accepts input reads and writes, calls from blocks, and calls to user functions", () => {
  const result = compileProject([
    main("m1.enable := TRUE; x := m1.enable; m1();"),
    block.replace(
      "running := running OR enable;",
      "delay(IN := enable, PT := T#1s, Q => running); scratch := F();",
    ),
    "FUNCTION F : INT F := 5; END_FUNCTION",
  ]);
  expect(result.diagnostics).toEqual([]);
});

it("checks implicit widening for both block kinds and rejects narrowing", () => {
  const wide = `FUNCTION_BLOCK Wide VAR_INPUT t : LTIME; END_VAR VAR_OUTPUT Q : TIME; END_VAR END_FUNCTION_BLOCK`;
  expect(
    compileProject([
      main(
        "a(t := T#1s, Q => elapsed); timer(PT := T#1s, ET => elapsed);",
        "a : Wide; timer : TON; elapsed : LTIME;",
      ),
      wide,
    ]).diagnostics,
  ).toEqual([]);
  const result = compileProject([
    main("a(t := LT#1s, Q => small);", "a : Wide; small : BOOL;"),
    wide,
  ]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.map((item) => item.code)).toContain("type.assign-mismatch");
});

it("rejects direct addresses on PROGRAM temporaries instead of silently ignoring I/O", () => {
  const result = compileProject([
    "PROGRAM Main VAR_TEMP pin AT %IX0.0 : BOOL; END_VAR END_PROGRAM",
  ]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "decl.temp-address", pou: "Main" }),
  );
});

it.each(["b.o.3 := TRUE;", "x := b.o.3;"])(
  "diagnoses unsupported chained FB bit access without crashing: %s",
  (body) => {
    const result = compileProject([
      `PROGRAM Main VAR b : Block; x : BOOL; END_VAR ${body} END_PROGRAM`,
      "FUNCTION_BLOCK Block VAR_INPUT o : WORD; END_VAR END_FUNCTION_BLOCK",
    ]);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "fb.unknown-member", args: { name: "b", member: "o.3" } }),
    );
  },
);

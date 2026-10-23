import { expect, it } from "vitest";
import { compileProject } from "./compile.js";

const block = `FUNCTION_BLOCK MotorStarter
VAR_INPUT enable : BOOL; END_VAR
VAR_OUTPUT running : BOOL; END_VAR
VAR hidden : INT; delay : TON; END_VAR
VAR_IN_OUT alias : INT; END_VAR
VAR_TEMP scratch : INT; END_VAR
END_FUNCTION_BLOCK`;
const main = (
  body = "",
  decl = "m : ARRAY[1..2] OF MotorStarter; t : ARRAY[1..4] OF TON; i, n : INT; flag : BOOL;",
) => `PROGRAM Main VAR ${decl} END_VAR ${body} END_PROGRAM`;

it("allocates standard and user elements with shared code and grouped monitor paths", () => {
  const result = compileProject([
    main(
      "t[i](IN := TRUE, PT := T#1s, Q => flag); m[i](enable := t[i].Q, alias := n); m[i].enable := TRUE; flag := m[i].enable;",
    ),
    block,
  ]);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir?.functionBlocks).toHaveLength(1);
  expect(result.ir?.instances?.map((instance) => instance.path)).toEqual(["M[1]", "M[2]"]);
  expect(result.ir?.variables.find((v) => v.key === "M[2].RUNNING")?.path).toEqual([
    "M",
    "[2]",
    "RUNNING",
  ]);
  expect(result.ir?.variables.find((v) => v.key === "T[4]")).toMatchObject({
    kind: "functionBlock",
    fbType: "TON",
    path: ["T", "[4]"],
  });
  expect(JSON.parse(JSON.stringify(result.ir))).toEqual(result.ir);
});

it.each([
  ["t[1].Q := TRUE;", "fb.output-not-writable"],
  ["t[1](Q := TRUE);", "fb.output-not-writable"],
  ["m[1].running := TRUE;", "fb.output-not-writable"],
  ["flag := m[1].hidden;", "fb.unknown-member"],
  ["flag := m[1].scratch;", "fb.unknown-member"],
  ["n := m[1].alias;", "fb.unknown-member"],
  ["flag := m[1].delay.Q;", "fb.unknown-member"],
  ["m[1](enable := TRUE);", "call.missing-in-out"],
  ["t[1](TRUE);", "fb.unsupported-call"],
  ["t[1](IN := TRUE, IN := FALSE);", "fb.duplicate-input"],
  ["t[1](IN => flag);", "call.invalid-parameter"],
  ["t[5]();", "type.invalid-constant"],
  ["t[TRUE]();", "type.array-index-not-integer"],
  ["t[1,2]();", "type.array-index-count"],
  ["t();", "fb.not-function-block"],
  ["flag := t.Q;", "fb.not-function-block"],
  ["t := t;", "fb.instance-as-value"],
  ["flag := t[1];", "fb.instance-as-value"],
  ["flag := SEL(TRUE, t, t);", "fb.instance-as-value"],
  ["n[1]();", "fb.not-function-block"],
])("checks indexed calls and access rules: %s", (body, code) => {
  const result = compileProject([main(body), block]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.map((d) => d.code)).toContain(code);
});

it.each(["TON", "MotorStarter"])("restricts %s instance arrays to persistent VAR", (type) => {
  for (const kind of ["FUNCTION", "FUNCTION_BLOCK", "PROGRAM"]) {
    for (const section of [
      "VAR",
      "VAR_TEMP",
      "VAR_INPUT",
      "VAR_OUTPUT",
      "VAR_IN_OUT",
      "VAR CONSTANT",
    ]) {
      if (kind !== "FUNCTION" && section === "VAR") continue;
      const result = compileProject([
        main(),
        block,
        `${kind} Other ${section} a : ARRAY[1..2] OF ${type}; END_VAR END_${kind}`,
      ]);
      expect(result.ir, `${kind} ${section}`).toBeUndefined();
      expect(result.diagnostics.some((d) => d.pou === "Other" && d.severity === "error")).toBe(
        true,
      );
    }
  }
});

it("rejects initializers and recursion through array elements", () => {
  expect(
    compileProject([main("", "t : ARRAY[1..2] OF TON := [0];")]).diagnostics.map((d) => d.code),
  ).toContain("decl.fb-initializer");
  const result = compileProject([
    "PROGRAM Main END_PROGRAM",
    "FUNCTION_BLOCK A VAR items : ARRAY[1..2] OF B; END_VAR END_FUNCTION_BLOCK",
    "FUNCTION_BLOCK B VAR items : ARRAY[1..2] OF A; END_VAR END_FUNCTION_BLOCK",
  ]);
  expect(result.diagnostics.map((d) => d.code)).toContain("pou.recursion");
});

it("selects one timer/counter variant across all elements and member assignments", () => {
  const result = compileProject([
    main(
      "t[1](PT := T#1s); t[i].PT := LTIME#2s; c[0,1](PV := INT#1); c[0,i].PV := UDINT#2;",
      "t : ARRAY[1..2] OF TON; c : ARRAY[0..1,1..2] OF CTU; i : INT;",
    ),
  ]);
  expect(result.diagnostics).toEqual([]);
  expect(
    result.ir?.variables
      .filter((v) => v.kind === "functionBlock")
      .map((v) => v.kind === "functionBlock" && v.fbType),
  ).toEqual(["TON_LTIME", "TON_LTIME", "CTU_LINT", "CTU_LINT", "CTU_LINT", "CTU_LINT"]);
});

it("excludes inferred element members from variant selection", () => {
  const result = compileProject([
    main("t[1](PT := t[2].ET); t[2](PT := LTIME#1s);", "t : ARRAY[1..2] OF TON;"),
  ]);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir?.variables).toMatchObject([{ fbType: "TON_LTIME" }, { fbType: "TON_LTIME" }]);
  const invalid = compileProject([main("t[1](PT := DINT#1);", "t : ARRAY[1..2] OF TON;")]);
  expect(invalid.diagnostics.map((d) => d.code)).toContain("fb.no-matching-variant");
});

it("selects independent variants for arrays sharing a multi-name declaration", () => {
  const result = compileProject([
    main("a[1](PV := DINT#40000); b[1](PV := ULINT#1);", "a,b : ARRAY[1..2] OF CTU;"),
  ]);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir?.variables).toMatchObject([
    { key: "A[1]", fbType: "CTU_DINT" },
    { key: "A[2]", fbType: "CTU_DINT" },
    { key: "B[1]", fbType: "CTU_ULINT" },
    { key: "B[2]", fbType: "CTU_ULINT" },
  ]);
});

it("counts monitored user block members toward the array leaf limit", () => {
  const sources = [
    "PROGRAM Main VAR m : ARRAY[1..5000] OF Many; END_VAR END_PROGRAM",
    "FUNCTION_BLOCK Many VAR numbers : ARRAY[1..2] OF INT; delay : TON; END_VAR END_FUNCTION_BLOCK",
  ];
  expect(compileProject(sources).diagnostics.map((d) => d.code)).toContain("type.invalid-constant");
  expect(compileProject([sources[0]!.replace("5000", "3333"), sources[1]!]).diagnostics).toEqual(
    [],
  );
});

it.each(["flag := m[1].flags.0;", "m[1].flags.0 := TRUE;"])(
  "rejects nested bit access on indexed block ports without crashing: %s",
  (body) => {
    const result = compileProject([
      main(body),
      block.replace("enable : BOOL;", "enable : BOOL; flags : BYTE;"),
    ]);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.map((d) => d.code)).toContain("fb.unknown-member");
  },
);

it.each(["TON", "MotorStarter"])(
  "names the actual %s type when a scalar instance is indexed",
  (type) => {
    for (const body of ["flag := t[1].Q;", "t[1]();"]) {
      const result = compileProject([main(body, `t : ${type}; flag : BOOL;`), block]);
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics.map(({ code, args }) => ({ code, args }))).toEqual([
        {
          code: "type.not-array",
          args: { type: { kind: "functionBlock", name: type.toUpperCase() } },
        },
      ]);
    }
  },
);

it.each(["TON", "MotorStarter"])(
  "explains nested %s instance arrays once per declaration",
  (type) => {
    const result = compileProject([main("", `t : ARRAY[1..2] OF ARRAY[1..2] OF ${type};`), block]);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.map(({ code, args }) => ({ code, args }))).toEqual([
      { code: "decl.fb-array-form", args: { form: "nested" } },
    ]);
  },
);

it.each(["TON", "MotorStarter"])(
  "explains named %s instance-array types without reporting known blocks as unknown",
  (type) => {
    const result = compileProject(
      [main(), block],
      [`TYPE Timers : ARRAY[1..2] OF ${type}; END_TYPE`],
    );
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.map(({ code, args }) => ({ code, args }))).toEqual([
      { code: "decl.fb-array-form", args: { form: "named" } },
    ]);
  },
);

it("reports one restriction for deeply nested instance arrays", () => {
  const result = compileProject([
    main("", "t : ARRAY[1..2] OF ARRAY[1..2] OF ARRAY[1..2] OF TON;"),
  ]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.map(({ code, args }) => ({ code, args }))).toEqual([
    { code: "decl.fb-array-form", args: { form: "nested" } },
  ]);
});

it("does not repeat an unsupported array type diagnostic when aliases revisit it", () => {
  const result = compileProject(
    ["PROGRAM Main END_PROGRAM"],
    [
      "TYPE Timers : ARRAY[1..2] OF TON; END_TYPE",
      "TYPE First : Timers; END_TYPE",
      "TYPE Second : Timers; END_TYPE",
    ],
  );
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.filter((d) => d.code === "decl.fb-array-form")).toHaveLength(1);
});

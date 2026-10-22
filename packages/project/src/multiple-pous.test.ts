import { compileProject } from "@benchtop-plc/compiler";
import { describe, expect, it } from "vitest";
import { readProject, SOURCE_NAMESPACE, writeProject } from "./index.js";
import type { Project } from "./index.js";

const main = "PROGRAM Main\nVAR x : INT; END_VAR\nx := Twice(n := Increment(2));\nEND_PROGRAM\n";
const increment =
  "// exact function text\r\nfunction Increment : INT\r\nVAR_INPUT a : INT := 3; END_VAR\r\nIncrement := a + 1;\r\nend_function;\r\n";
const twice =
  "FUNCTION Twice : INT\nVAR_INPUT n : INT; END_VAR\nVAR_OUTPUT seen : INT; END_VAR\nVAR scratch : INT := 2; END_VAR\nVAR_INPUT extra : INT := 0; END_VAR\nTwice := n * scratch + extra; seen := n;\nEND_FUNCTION";
const procedure =
  "FUNCTION Notify\nVAR_INPUT n : INT := 1; END_VAR\nVAR_OUTPUT seen : INT; END_VAR\nseen := n;\nEND_FUNCTION";

function project(pous: string[]): Project {
  return {
    fileHeader: {
      companyName: "benchtop-plc",
      productName: "benchtop-plc",
      productVersion: "0.3.0",
      creationDateTime: "2026-10-22T00:00:00Z",
    },
    contentHeader: { name: "Functions" },
    pous,
    configuration: "Config",
    resource: "Res",
    task: { name: "Cyclic", interval: "PT0.01S", priority: 1 },
    instance: { name: "mainInstance", typeName: "Main" },
    panel: null,
  };
}
function save(pous: string[]): string {
  const result = writeProject(project(pous));
  expect(result.diagnostics).toEqual([]);
  expect(result.value).not.toBeNull();
  return result.value!;
}
function withoutSource(xml: string): string {
  return xml.replace(
    new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"),
    "",
  );
}
function executable(ir: unknown): unknown {
  // Canonical declarations change source locations, never executable IR.
  return JSON.parse(
    JSON.stringify(ir, (key, value: unknown) => (key === "span" ? undefined : value)),
  );
}

describe("several POUs in PLCopen XML", () => {
  it("round trips ordered constants and dependent initializers in every POU", () => {
    const pous = [
      "PROGRAM Main VAR CONSTANT N : INT := 10; END_VAR VAR A : INT := N; END_VAR VAR CONSTANT UpperBound : INT := N + 1; END_VAR END_PROGRAM",
      "FUNCTION F : INT VAR CONSTANT N : INT := 30000; Wrapped : INT := N + N; END_VAR VAR_INPUT A : INT := Wrapped; END_VAR F := A; END_FUNCTION",
      "FUNCTION_BLOCK Block VAR CONSTANT N : INT; END_VAR VAR A : INT := N; END_VAR END_FUNCTION_BLOCK",
    ];
    const xml = save(pous);
    expect(xml.match(/<localVars constant="true">/g)).toHaveLength(4);
    expect(readProject(xml).value!.pous).toEqual(pous);
    const canonical = readProject(withoutSource(xml));
    expect(canonical.diagnostics).toEqual([]);
    expect(canonical.value!.pous[0]).toMatch(/VAR CONSTANT[\s\S]*VAR\n[\s\S]*VAR CONSTANT/);
    const original = compileProject(pous);
    expect(original.diagnostics).toEqual([]);
    expect(executable(compileProject(canonical.value!.pous).ir)).toEqual(executable(original.ir));
    expect(readProject(writeProject(canonical.value!).value!).value!.pous).toEqual(
      canonical.value!.pous,
    );
  });

  it("checks initializers using earlier constants on save and open", () => {
    const source =
      "PROGRAM Main VAR CONSTANT N : DINT := 10; END_VAR VAR A : INT := DINT_TO_INT(N); END_VAR END_PROGRAM";
    const xml = save([source]);
    // The constant's own value is valid, but its dependent INT initializer is not.
    const dependent = source
      .replace("N : DINT := 10", "N : DINT := 40000")
      .replace("DINT_TO_INT(N)", "N");
    expect(writeProject(project([dependent])).value).toBeNull();
    expect(readProject(xml.replace('value="DINT_TO_INT(N)"', 'value="N"')).value).toBeNull();
    expect(writeProject(project([source.replace("DINT := 10", "INT := 40000")])).value).toBeNull();
  });

  it.each(["true", "1", "false", "0"])("reads XML boolean constant=%s", (value) => {
    const source = "PROGRAM Main VAR N : INT := 10; END_VAR END_PROGRAM";
    const xml = withoutSource(save([source])).replace(
      "<localVars>",
      `<localVars constant="${value}">`,
    );
    const reopened = readProject(xml);
    expect(reopened.diagnostics).toEqual([]);
    expect(reopened.value!.pous[0]!.includes("VAR CONSTANT")).toBe(["true", "1"].includes(value));
  });

  it("rejects invalid XML constant flags", () => {
    expect(
      readProject(
        save(["PROGRAM Main VAR N : INT; END_VAR END_PROGRAM"]).replace(
          "<localVars>",
          '<localVars constant="yes">',
        ),
      ).value,
    ).toBeNull();
  });

  it("preserves project order and exact source, with per-POU extensions", () => {
    const pous = [increment, main, twice];
    const xml = save(pous);
    expect(xml.match(/<source:source/g)).toHaveLength(3);
    expect(xml).toContain("<returnType><INT/></returnType>");
    expect(xml).toContain('<pouInstance name="mainInstance" typeName="Main"/>');
    expect(readProject(xml)).toEqual({ value: project(pous), diagnostics: [] });
    const canonical = readProject(withoutSource(xml));
    expect(canonical.diagnostics).toEqual([]);
    const original = compileProject(pous);
    const imported = compileProject(canonical.value!.pous);
    expect(original.diagnostics).toEqual([]);
    expect(imported.diagnostics).toEqual([]);
    expect(executable(imported.ir)).toEqual(executable(original.ir));
    expect(canonical.value!.pous[2]).toMatch(
      /VAR_INPUT[\s\S]*VAR_OUTPUT[\s\S]*VAR\n[\s\S]*VAR_INPUT/,
    );
  });

  it("round trips a function without a result, including canonical imports", () => {
    const pous = ["PROGRAM Main\nNotify(n := 2);\nEND_PROGRAM", procedure];
    const xml = save(pous);
    expect(xml).not.toContain("returnType");
    expect(readProject(xml).value!.pous).toEqual(pous);
    const canonical = readProject(withoutSource(xml));
    expect(canonical.diagnostics).toEqual([]);
    expect(compileProject(canonical.value!.pous).diagnostics).toEqual([]);
  });

  it.each([
    ["missing call", [main], "call.unknown-function"],
    [
      "several programs",
      ["PROGRAM First END_PROGRAM", "PROGRAM Second END_PROGRAM"],
      "pou.program-count",
    ],
    ["no program", [increment, procedure], "pou.program-count"],
    ["empty project", [], "pou.program-count"],
    ["duplicate names", [main, increment, twice, increment], "pou.duplicate"],
    [
      "undeclared initializer",
      ["PROGRAM Main VAR x : INT := missing + 1; END_VAR END_PROGRAM"],
      "name.undeclared",
    ],
    [
      "duplicate variables",
      ["PROGRAM Main VAR x : INT; x : BOOL := TRUE; END_VAR END_PROGRAM"],
      "decl.duplicate",
    ],
    [
      "program parameters",
      ["PROGRAM Main VAR_INPUT x : INT := 1; END_VAR END_PROGRAM"],
      "pou.invalid-section",
    ],
    [
      "function address",
      ["PROGRAM Main END_PROGRAM", "FUNCTION F VAR flag AT %IX0.0 : BOOL; END_VAR END_FUNCTION"],
      "pou.direct-address",
    ],
  ] as const)("preserves semantic errors: %s", (_, sources, code) => {
    const pous = [...sources];
    const xml = save(pous);
    const reopened = readProject(xml);
    expect(reopened.diagnostics).toEqual([]);
    expect(reopened.value!.pous).toEqual(pous);
    expect(compileProject(reopened.value!.pous).diagnostics.map((item) => item.code)).toContain(
      code,
    );
    expect(readProject(withoutSource(xml)).value).not.toBeNull();
  });

  it("binds the first program and omits the instance when no program exists", () => {
    expect(save([procedure, "PROGRAM First END_PROGRAM", main])).toContain('typeName="First"');
    const xml = save([procedure]);
    expect(xml).not.toContain("pouInstance");
    expect(readProject(xml).value).not.toHaveProperty("instance");
    expect(readProject(save([main]).replace(/<pouInstance[^>]*\/>/, "")).value).not.toBeNull();
  });

  it.each(["missing", "Notify"])("rejects an instance naming %s instead of a program", (name) => {
    const result = readProject(
      save([main, procedure]).replace('typeName="Main"', `typeName="${name}"`),
    );
    expect(result.value).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: "project.invalid" }));
  });

  it.each(["globalVars", "unknownVars"])("rejects unsupported XML section %s", (section) => {
    expect(readProject(save([procedure]).replaceAll("inputVars", section)).value).toBeNull();
  });

  it.each(["unknown"])("rejects unsupported POU type %s", (kind) => {
    expect(
      readProject(save([procedure]).replace('pouType="function"', `pouType="${kind}"`)).value,
    ).toBeNull();
  });

  it("preserves a representable constant modifier on an invalid section", () => {
    const source = procedure.replace("VAR_INPUT", "VAR_INPUT CONSTANT");
    const xml = save([source]);
    expect(xml).toContain('<inputVars constant="true">');
    expect(readProject(xml).value!.pous).toEqual([source]);
    expect(compileProject(readProject(withoutSource(xml)).value!.pous).diagnostics).toContainEqual(
      expect.objectContaining({ code: "decl.constant-section" }),
    );
  });

  it("preserves empty in-out sections in the exact source extension", () => {
    const pous = ["FUNCTION F VAR_IN_OUT END_VAR END_FUNCTION"];
    expect(readProject(save(pous)).value!.pous).toEqual(pous);
  });

  it("checks every POU initializer and does not let a semantic error hide an invalid value", () => {
    const valid = "FUNCTION F : INT VAR_INPUT x : INT := 1; END_VAR F := x; END_FUNCTION";
    const xml = save([main, valid]);
    const invalid = valid.replace(":= 1;", ":= 40000;");
    expect(writeProject(project([main, invalid])).value).toBeNull();
    expect(readProject(xml.replace('value="1"', 'value="40000"')).value).toBeNull();
    const badMixed =
      "PROGRAM Main VAR missingType : Unknown; x : INT := 40000; unresolved : INT := missing; END_VAR END_PROGRAM";
    expect(writeProject(project([badMixed])).value).toBeNull();
  });

  it("does not use variables from a different POU to validate initializers", () => {
    const pous = [
      "PROGRAM Main VAR x : BOOL; END_VAR END_PROGRAM",
      "FUNCTION F VAR y : INT := x; END_VAR END_FUNCTION",
    ];
    expect(readProject(save(pous)).value!.pous).toEqual(pous);
  });

  it("restores only the unchanged POU source after an external edit", () => {
    const xml = save([increment, main, twice]).replace(
      "<returnType><INT/></returnType>",
      "<returnType><DINT/></returnType>",
    );
    const result = readProject(xml);
    expect(result.diagnostics.map((item) => item.code)).toEqual(["project.stale-source"]);
    expect(result.value!.pous[0]).toContain("FUNCTION Increment : DINT");
    expect(result.value!.pous.slice(1)).toEqual([main, twice]);
  });
});

it("round trips blocks, nested user/standard instances and temporary sections without changing POU texts", () => {
  const pous = [
    `PROGRAM Main\nVAR m1,m2 : Wrapper; result : BOOL; END_VAR\nVAR_TEMP temp : INT := 3; END_VAR\nm1(Q => result); m2();\nEND_PROGRAM`,
    `FUNCTION_BLOCK Wrapper\nVAR_OUTPUT Q : BOOL; END_VAR\nVAR nested : Delayed; END_VAR\nnested(enable := TRUE, Q => Q);\nEND_FUNCTION_BLOCK`,
    `FUNCTION_BLOCK Delayed\nVAR_INPUT enable : BOOL; END_VAR\nVAR_OUTPUT Q : BOOL; END_VAR\nVAR delay : TON; END_VAR\nVAR_TEMP scratch : INT := 5; END_VAR\ndelay(IN := enable, PT := T#1s, Q => Q);\nEND_FUNCTION_BLOCK`,
  ];
  const xml = save(pous);
  expect(xml).toContain('pouType="functionBlock"');
  expect(xml).toContain('<derived name="WRAPPER"/>');
  expect(xml).toContain("<tempVars>");
  expect(readProject(xml)).toEqual({ value: project(pous), diagnostics: [] });
  const canonical = readProject(withoutSource(xml));
  expect(canonical.diagnostics).toEqual([]);
  const original = compileProject(pous),
    imported = compileProject(canonical.value!.pous);
  expect(original.diagnostics).toEqual([]);
  expect(imported.diagnostics).toEqual([]);
  expect(executable(imported.ir)).toEqual(executable(original.ir));
});

it("preserves parseable but semantically disallowed temporary function locals and block addresses", () => {
  const pous = [
    "PROGRAM Main END_PROGRAM",
    "FUNCTION F VAR_TEMP x : INT := 3; END_VAR END_FUNCTION",
    "FUNCTION_BLOCK B VAR pin AT %IX0.0 : BOOL; END_VAR END_FUNCTION_BLOCK",
  ];
  expect(readProject(save(pous)).value!.pous).toEqual(pous);
  expect(compileProject(pous).diagnostics.map((item) => item.code)).toEqual([
    "pou.invalid-section",
    "pou.direct-address",
  ]);
});

it("round trips function and block in-outs through inOutVars and canonical imports", () => {
  const pous = [
    "PROGRAM Main VAR x : INT; inst : B; END_VAR F(n := x); inst(n := x); END_PROGRAM",
    "FUNCTION F VAR_IN_OUT n : INT; END_VAR n := n + 1; END_FUNCTION",
    "FUNCTION_BLOCK B VAR_IN_OUT n : INT; END_VAR F(n := n); END_FUNCTION_BLOCK",
  ];
  const xml = save(pous);
  expect(xml.match(/<inOutVars>/g)).toHaveLength(2);
  expect(readProject(xml)).toEqual({ value: project(pous), diagnostics: [] });
  const canonical = readProject(withoutSource(xml));
  expect(canonical.diagnostics).toEqual([]);
  expect(canonical.value!.pous[1]).toContain("VAR_IN_OUT");
  const original = compileProject(pous),
    imported = compileProject(canonical.value!.pous);
  expect(original.diagnostics).toEqual([]);
  expect(imported.diagnostics).toEqual([]);
  expect(executable(imported.ir)).toEqual(executable(original.ir));
});

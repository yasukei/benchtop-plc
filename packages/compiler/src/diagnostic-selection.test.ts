import { expect, it } from "vitest";
import { compileProject, parsePou } from "./index.js";

const resource = "CONFIGURATION Plant RESOURCE Station ON Cpu";
const task = `${resource} TASK T (INTERVAL := T#20ms, PRIORITY := 1);`;
const main = "PROGRAM Main END_PROGRAM";

it.each([
  ["VAR a : ARRAY[1..z] OF INT; END_VAR", ""],
  ["VAR a : INT := z; END_VAR", ""],
  ["VAR a : INT; END_VAR", "CASE a OF z: a := 1; END_CASE;"],
])("keeps rejected CONSTANT temporaries available in constant contexts: %s %s", (locals, body) => {
  const source = `FUNCTION_BLOCK BlockType VAR_TEMP CONSTANT z : INT := 2; END_VAR
    ${locals} ${body} END_FUNCTION_BLOCK`;
  expect(compileProject([main, source]).diagnostics).toEqual([
    expect.objectContaining({ code: "decl.constant-section", args: { section: "VAR_TEMP" } }),
  ]);
});

it.each([
  ["", "syntax.unexpected-eof", {}],
  ["CONFIGURATION", "syntax.unexpected-eof", {}],
  ["CONFIGURATION Plant", "syntax.missing-end", { expected: "END_CONFIGURATION" }],
  ["CONFIGURATION Plant RESOURCE", "syntax.unexpected-eof", {}],
  ["CONFIGURATION Plant RESOURCE Station", "syntax.unexpected-eof", {}],
  ["CONFIGURATION Plant RESOURCE Station ON", "syntax.unexpected-eof", {}],
  [resource, "syntax.missing-end", { expected: "END_RESOURCE" }],
  [`${resource} TASK`, "syntax.unexpected-eof", {}],
  [`${resource} TASK T`, "syntax.unexpected-eof", {}],
  [`${resource} TASK T (`, "syntax.unexpected-eof", {}],
  [`${resource} TASK T (INTERVAL`, "syntax.unexpected-eof", {}],
  [`${resource} TASK T (INTERVAL :=`, "syntax.unexpected-eof", {}],
  [`${resource} TASK T (INTERVAL := T#20ms`, "syntax.unexpected-eof", {}],
  [`${resource} TASK T (INTERVAL := T#20ms,`, "syntax.unexpected-eof", {}],
  [`${resource} TASK T (INTERVAL := T#20ms, PRIORITY := 1)`, "syntax.unexpected-eof", {}],
  [task, "syntax.missing-end", { expected: "END_RESOURCE" }],
  [`${task} PROGRAM`, "syntax.unexpected-eof", {}],
  [`${task} PROGRAM Instance`, "syntax.unexpected-eof", {}],
  [`${task} PROGRAM Instance WITH`, "syntax.unexpected-eof", {}],
  [`${task} PROGRAM Instance WITH T :`, "syntax.unexpected-eof", {}],
  [`${task} PROGRAM Instance WITH T : Lib.`, "syntax.unexpected-eof", {}],
  [`${task} PROGRAM Instance WITH T : Main`, "syntax.unexpected-eof", {}],
  [`${task} PROGRAM Instance WITH T : Main;`, "syntax.missing-end", { expected: "END_RESOURCE" }],
  [`${task} END_RESOURCE`, "syntax.missing-end", { expected: "END_CONFIGURATION" }],
  ["CONFIGURATION Plant VAR_GLOBAL", "syntax.missing-end", { expected: "END_VAR" }],
  ["CONFIGURATION Plant VAR_GLOBAL x :", "syntax.unexpected-eof", {}],
  ["CONFIGURATION Plant VAR_GLOBAL x : INT", "syntax.unexpected-eof", {}],
  ["CONFIGURATION Plant VAR_GLOBAL x : INT;", "syntax.missing-end", { expected: "END_VAR" }],
  [`${resource} VAR_GLOBAL x : INT;`, "syntax.missing-end", { expected: "END_VAR" }],
])("reports the innermost unfinished configuration construct in %s", (source, code, args) => {
  const result = compileProject([main], [], source);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code,
      args,
      sourceKind: "configuration",
      sourceIndex: 0,
      span: { line: 1, column: source.length + 1, endLine: 1, endColumn: source.length + 1 },
    }),
  ]);
});

it.each([
  ["CONFIGURATION :", "syntax.expected-identifier", { found: ":" }],
  ["CONFIGURATION IF", "syntax.reserved-identifier", { name: "IF" }],
  [
    "CONFIGURATION Plant RESOURCE Station :",
    "syntax.expected-token",
    { expected: "ON", found: ":" },
  ],
])("keeps expected-token diagnostics for real tokens in %s", (source, code, args) => {
  expect(compileProject([main], [], source).diagnostics).toEqual([
    expect.objectContaining({ code, args }),
  ]);
});

it.each(["end_if : INT;", "end_while, x : INT;", "end_case AT %MW0 : INT;", "end_var : INT;"])(
  "reports a reserved declaration name in %s",
  (declaration) => {
    const source = `PROGRAM Main VAR ${declaration} END_VAR END_PROGRAM`;
    const name = declaration.split(/[ ,]/)[0]!;
    expect(compileProject([source]).diagnostics).toEqual([
      expect.objectContaining({ code: "syntax.reserved-identifier", args: { name } }),
    ]);
  },
);

it("still reports a missing END_VAR at an enclosing terminator", () => {
  expect(parsePou("PROGRAM Main VAR x : INT; END_PROGRAM").diagnostics).toEqual([
    expect.objectContaining({ code: "syntax.missing-end", args: { expected: "END_VAR" } }),
  ]);
});

it("reports a missing END_RESOURCE at END_CONFIGURATION", () => {
  expect(compileProject([main], [], `${task} END_CONFIGURATION`).diagnostics).toEqual([
    expect.objectContaining({ code: "syntax.missing-end", args: { expected: "END_RESOURCE" } }),
  ]);
});

it.each([
  ["end_if", "end_if"],
  ["end_var", "end_var"],
  ["x, end_var", "end_var"],
])("reports a reserved global name in %s", (names, name) => {
  const source = `CONFIGURATION Plant VAR_GLOBAL ${names} : INT; END_VAR
    RESOURCE Station ON Cpu TASK T (INTERVAL := T#20ms, PRIORITY := 1);
    PROGRAM Instance WITH T : Main; END_RESOURCE END_CONFIGURATION`;
  expect(compileProject([main], [], source).diagnostics).toEqual([
    expect.objectContaining({ code: "syntax.reserved-identifier", args: { name } }),
  ]);
});

it.each([
  ["F(EN := TRUE, value := 1)", "EN"],
  ["F(value := 1, en := TRUE)", "en"],
  ["F(value := 1, ENO => flag)", "ENO"],
  ["ABS(EN := TRUE, IN := 1)", "EN"],
  ["timer(EN := TRUE, IN := TRUE)", "EN"],
  ["timer(IN := TRUE, eno => flag)", "eno"],
])("reports the unsupported enable parameter in %s", (call, construct) => {
  const source = `PROGRAM Main VAR flag : BOOL; timer : TON; END_VAR ${call}; END_PROGRAM`;
  const result = compileProject([
    source,
    "FUNCTION F : INT VAR_INPUT value : INT; END_VAR F := value; END_FUNCTION",
  ]);
  expect(result.ir).toBeUndefined();
  const column = source.indexOf(call) + call.indexOf(construct) + 1;
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code: "syntax.unsupported-construct",
      args: { construct },
      span: { line: 1, column, endLine: 1, endColumn: column + construct.length },
    }),
  ]);
});

it.each(["F(1)", "F(value := 1)"])(
  "keeps rejected CONSTANT input parameters available to %s",
  (call) => {
    const result = compileProject([
      `PROGRAM Main ${call}; END_PROGRAM`,
      "FUNCTION F : INT VAR_INPUT CONSTANT value : INT; END_VAR F := value; END_FUNCTION",
    ]);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "decl.constant-section", args: { section: "VAR_INPUT" } }),
    ]);
  },
);

it.each([
  [
    "block(value := 1)",
    "FUNCTION_BLOCK BlockType VAR_INPUT CONSTANT value : INT; END_VAR value := value + 1; END_FUNCTION_BLOCK",
  ],
  [
    "block.Run(value := 1)",
    "FUNCTION_BLOCK BlockType METHOD PUBLIC Run VAR_INPUT CONSTANT value : INT; END_VAR value := value + 1; END_METHOD END_FUNCTION_BLOCK",
  ],
])("keeps rejected CONSTANT inputs available to %s", (call, block) => {
  const result = compileProject([
    `PROGRAM Main VAR block : BlockType; END_VAR ${call}; END_PROGRAM`,
    block,
  ]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ code: "decl.constant-section", args: { section: "VAR_INPUT" } }),
  ]);
});

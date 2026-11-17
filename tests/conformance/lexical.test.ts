import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { compile, compileProject, isKeyword, lex } from "@benchtop-plc/compiler";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

// Maintainer-supplied extraction from the formal syntax of JIS B 3503:2016,
// including TRUE and FALSE. This is independent of the implementation's word list.
const editionKeywords = readFileSync(
  new URL("./fixtures/edition3-keywords.txt", import.meta.url),
  "utf8",
)
  .trim()
  .split(/\s+/);

it.each(editionKeywords)("reserves the edition's keyword %s", (word) => {
  const spelling = word.toLowerCase();
  expect(isKeyword(spelling)).toBe(true);
  const result = lex(spelling);
  expect(result.diagnostics).toEqual([]);
  expect(result.tokens?.[0]?.kind).toBe(["TRUE", "FALSE"].includes(word) ? "boolean" : "keyword");
  // After a comma, even CONSTANT and RETAIN unambiguously occupy a name position.
  const compiled = compile(`PROGRAM Main VAR value, ${spelling} : INT; END_VAR END_PROGRAM`);
  expect(compiled.ir).toBeUndefined();
  expect(compiled.diagnostics).toEqual([
    expect.objectContaining({ code: "syntax.reserved-identifier", args: { name: spelling } }),
  ]);
});

it.each([
  ["__d : INT;", "lex.invalid-identifier"],
  ["a__b : INT;", "lex.invalid-identifier"],
  ["c_ : INT;", "lex.invalid-identifier"],
  ["CONTINUE : INT;", "syntax.reserved-identifier"],
  ["x : REAL := 1E5;", "lex.malformed-number"],
  ["x : INT := INT#-16#FF;", "lex.malformed-number"],
  ["x : TIME := T#1h75m;", "lex.malformed-number"],
])("rejects the nonconforming declaration %s", (declaration, code) => {
  const result = compile(`PROGRAM Main VAR ${declaration} END_VAR END_PROGRAM`);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toEqual([expect.objectContaining({ code })]);
});

it.each([
  ["REAL", "1.0E5", 100000],
  ["INT", "-16#FF", -255],
  ["INT", "INT#-255", -255],
  ["TIME", "T#25h15m", 90900000],
  ["TIME", "T#75m", 4500000],
  ["TIME", "T#1000us", 1],
  ["TIME", "T#1500us", 1],
  ["TIME", "T#500us", 0],
  ["TIME", "TIME#-1500us", -1],
  ["TIME", "TIME#-500us", 0],
  ["TIME", "T#1500000ns", 1],
  ["TIME", "T#-1500000ns", -1],
  ["TIME", "T#1ms999us999ns", 1],
  ["TIME", "T#12h4m34ms230us400ns", 43440034],
  ["LTIME", "LTIME#5m_30s_500ms_100.1us", "330500100100"],
])("preserves %s %s in initialization and execution", (type, expression, expected) => {
  const result = compile(`PROGRAM Main
VAR _initial : ${type} := ${expression}; a_b : ${type}; END_VAR
a_b := ${expression}; END_PROGRAM`);
  expect(result.diagnostics).toEqual([]);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(result.ir!);
  expect(runtime.step().variables).toMatchObject([{ value: expected }, { value: expected }]);
});

it.each(["T#2147483647ms1us", "T#-2147483648ms1ns"])(
  "checks the exact TIME range before truncating %s",
  (expression) => {
    expect(
      compile(`PROGRAM Main VAR x : TIME := ${expression}; END_VAR END_PROGRAM`).diagnostics,
    ).toEqual([expect.objectContaining({ code: "type.invalid-constant" })]);
  },
);

it("reports a CONTINUE declaration in every source category", () => {
  const result = compileProject(
    ["PROGRAM Main VAR Continue : INT; END_VAR END_PROGRAM"],
    ["TYPE Continue : INT; END_TYPE"],
    "CONFIGURATION Continue END_CONFIGURATION",
  );
  expect(result.diagnostics).toEqual(
    ["configuration", "dataType", undefined].map((sourceKind) =>
      expect.objectContaining({
        code: "syntax.reserved-identifier",
        sourceIndex: 0,
        ...(sourceKind ? { sourceKind } : {}),
        args: { name: "Continue" },
      }),
    ),
  );
});

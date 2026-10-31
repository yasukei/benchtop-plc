import { compileProject } from "@benchtop-plc/compiler";
import { expect, it } from "vitest";
import { blockTypeAt as compiledBlockTypeAt } from "./block-hover.js";

function blockTypeAt(
  sources: readonly string[],
  sourceIndex: number,
  position: number,
  dataTypes: readonly string[] = [],
  configuration?: string,
) {
  const result = compileProject(sources, dataTypes, configuration);
  return compiledBlockTypeAt(sources[sourceIndex]!, position, result.ir);
}

it("shows selected variants on declarations and uses, excluding comments and member names", () => {
  const source = `PROGRAM Main VAR c: CTU; END_VAR
    // c is a counter
    c(PV := DINT#40000); END_PROGRAM`;
  for (const position of [source.indexOf("c:"), source.indexOf("c(PV")])
    expect(blockTypeAt([source], 0, position)).toMatchObject({
      text: "c: CTU_DINT",
      from: position,
      to: position + 1,
    });
  expect(blockTypeAt([source], 0, source.indexOf("c is"))).toBeNull();
  expect(blockTypeAt([source], 0, source.indexOf("PV"))).toBeNull();
});

it("resolves in uninstantiated user blocks and refreshes after editing the binding", () => {
  const main = "PROGRAM Main END_PROGRAM";
  const block = "FUNCTION_BLOCK Block VAR c: CTU; END_VAR c(PV := ULINT#1); END_FUNCTION_BLOCK";
  expect(blockTypeAt([main, block], 1, block.indexOf("c:"))?.text).toBe("c: CTU_ULINT");
  const changed = block.replace("ULINT#1", "DINT#1");
  expect(blockTypeAt([main, changed], 1, changed.indexOf("c:"))?.text).toBe("c: CTU_DINT");
  expect(
    blockTypeAt([main, block.replace("ULINT#1", "100000")], 1, block.indexOf("c:")),
  ).toBeNull();
});

it("keeps block hovers available when the project uses declared data types", () => {
  const source = "PROGRAM Main VAR s : State; c : CTU; END_VAR c(PV := DINT#40000); END_PROGRAM";
  expect(
    blockTypeAt([source], 0, source.indexOf("c :"), ["TYPE State : (Idle, Running); END_TYPE"])
      ?.text,
  ).toBe("c: CTU_DINT");
});

it("shows declared named and inline types on variables in every POU kind", () => {
  const types = ["TYPE State : (Idle, Running); END_TYPE", "TYPE Speed : INT; END_TYPE"];
  const main =
    "PROGRAM Main VAR phase : State; percent : INT (0..100); END_VAR phase := State#Running; END_PROGRAM";
  expect(compileProject([main], types).diagnostics).toEqual([]);
  for (const position of [main.indexOf("phase :"), main.indexOf("phase :=")])
    expect(blockTypeAt([main], 0, position, types)?.text).toBe("phase: State");
  expect(blockTypeAt([main], 0, main.indexOf("percent"), types)?.text).toBe(
    "percent: INT (0..100)",
  );
  const fn = "FUNCTION F : Speed VAR_INPUT n : Speed; END_VAR F := n; END_FUNCTION";
  expect(blockTypeAt([main, fn], 1, fn.indexOf("n;"), types)?.text).toBe("n: Speed");
  const block =
    "FUNCTION_BLOCK Block VAR_OUTPUT s : State; END_VAR s := State#Idle; END_FUNCTION_BLOCK";
  expect(blockTypeAt([main, block], 1, block.indexOf("s :="), types)?.text).toBe("s: State");
});

it("distinguishes formal parameter names from same-named local variables", () => {
  const main = `PROGRAM Main
VAR t : TON; IN, Q : BOOL; n : DINT; END_VAR
t(IN := IN, PT := T#1s, Q => Q);
n := F(n := n);
END_PROGRAM`;
  const fn = "FUNCTION F : DINT VAR_INPUT n : LINT; END_VAR F := LINT_TO_DINT(n); END_FUNCTION";
  const sources = [main, fn];
  expect(compileProject(sources).diagnostics).toEqual([]);
  for (const formal of ["IN :=", "Q =>", "n := n)"])
    expect(blockTypeAt(sources, 0, main.indexOf(formal))).toBeNull();
  for (const [actual, expected] of [
    ["IN, PT", "IN: BOOL"],
    ["Q);", "Q: BOOL"],
    ["n);", "n: DINT"],
  ])
    expect(blockTypeAt(sources, 0, main.indexOf(actual!))?.text).toBe(expected);
  // A declaration after a comma is still a variable, not a formal argument.
  expect(blockTypeAt(sources, 0, main.indexOf("Q :"))?.text).toBe("Q: BOOL");
});

it("shows full array types including nested dimensions", () => {
  const source =
    "PROGRAM Main VAR a : ARRAY[-1..2,0..1] OF ARRAY[1..3] OF INT; END_VAR a[0,1][2] := 3; END_PROGRAM";
  expect(blockTypeAt([source], 0, source.indexOf("a :"))?.text).toBe(
    "a: ARRAY[-1..2, 0..1] OF ARRAY[1..3] OF INT",
  );
});

it("shows selected array variants inside uninstantiated user blocks", () => {
  const main = "PROGRAM Main END_PROGRAM";
  const block =
    "FUNCTION_BLOCK Block VAR c : ARRAY[1..2] OF CTU; END_VAR c[1](PV := DINT#40000); END_FUNCTION_BLOCK";
  for (const position of [block.indexOf("c :"), block.indexOf("c[1]")])
    expect(blockTypeAt([main, block], 1, position)?.text).toBe("c: ARRAY[1..2] OF CTU_DINT");
});

it("shows a reference's complete target type in variable hovers", () => {
  const source = "PROGRAM Main VAR r : REF_TO ARRAY[1..2] OF INT; END_VAR END_PROGRAM";
  expect(blockTypeAt([source], 0, source.indexOf("r :"))?.text).toBe(
    "r: REF_TO ARRAY[1..2] OF INT",
  );
});

const configuredSources = [
  `PROGRAM Main
VAR count : DINT; c : CTU; END_VAR
VAR_EXTERNAL shared : INT; timer : TON; timers : ARRAY[1..2] OF TON; END_VAR
count := shared;
c(PV := DINT#40000);
timer(IN := TRUE);
timers[1](IN := TRUE);
END_PROGRAM`,
  `PROGRAM Other
VAR count : BOOL; c : CTU; END_VAR
VAR_EXTERNAL shared : INT; timer : TON; timers : ARRAY[1..2] OF TON; END_VAR
count := shared > 0;
c(PV := ULINT#1);
timer(PT := LT#1s);
timers[1](PT := LT#1s);
END_PROGRAM`,
];
const configuration = `CONFIGURATION Plant
VAR_GLOBAL shared : INT; timer : TON; END_VAR
RESOURCE Station ON BENCHTOP
VAR_GLOBAL timers : ARRAY[1..2] OF TON; END_VAR
TASK Tick (INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM First WITH Tick : Other;
PROGRAM Second WITH Tick : Main;
END_RESOURCE
END_CONFIGURATION`;

it("uses the configured compilation for distinct program locals and inferred block variants", () => {
  const result = compileProject(configuredSources, [], configuration);
  expect(result.diagnostics).toEqual([]);
  for (const [index, type, counter] of [
    [0, "DINT", "CTU_DINT"],
    [1, "BOOL", "CTU_ULINT"],
  ] as const) {
    const source = configuredSources[index]!;
    for (const text of ["count :", "count :="])
      expect(compiledBlockTypeAt(source, source.indexOf(text), result.ir)?.text).toBe(
        `count: ${type}`,
      );
    expect(compiledBlockTypeAt(source, source.indexOf("c(PV"), result.ir)?.text).toBe(
      `c: ${counter}`,
    );
  }
});

it("shows configuration and resource globals and bound externals with their selected types", () => {
  const result = compileProject(configuredSources, [], configuration);
  expect(result.diagnostics).toEqual([]);
  for (const source of [...configuredSources, configuration]) {
    for (const [name, type] of [
      ["shared", "INT"],
      ["timer", "TON_LTIME"],
      ["timers", "ARRAY[1..2] OF TON_LTIME"],
    ]) {
      const position = source.indexOf(`${name} :`);
      // The resource global array is declared in the same configuration source.
      expect(compiledBlockTypeAt(source, position, result.ir)?.text).toBe(`${name}: ${type}`);
    }
  }
});

it("returns no hover while the current editor compilation is unavailable", () => {
  const source = configuredSources[0]!;
  expect(compiledBlockTypeAt(source, source.indexOf("count :"))).toBeNull();
});

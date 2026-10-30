import { describe, expect, it } from "vitest";
import {
  compileProject,
  MAX_SOURCE_NESTING,
  MAX_SOURCE_TREE_DEPTH,
  parsePou,
  parseDataType,
} from "@benchtop-plc/compiler";
import { readProject, writeProject } from "@benchtop-plc/project";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";
import {
  failedOperandsProject,
  nestingCases,
  nestingProject,
  nestingSource,
  nestingBoundary,
  chainCases,
  chainProject,
} from "./source-nesting.test-support.js";

it.each(["calls", "comparisons"] as const)("checks failed nested %s only once", (kind) => {
  const depth = kind === "calls" ? MAX_SOURCE_NESTING : MAX_SOURCE_NESTING / 2;
  const project = failedOperandsProject(kind, depth);
  const result = compileProject(project.pous, project.dataTypes);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(result.diagnostics.length).toBeLessThanOrEqual(2 * depth + 1);
  expect(result.diagnostics.some((diagnostic) => diagnostic.code === "syntax.nesting-limit")).toBe(
    false,
  );
  if (kind === "comparisons")
    expect(
      result.diagnostics.filter((diagnostic) => diagnostic.code === "name.undeclared"),
    ).toHaveLength(1);
});

describe.each(nestingCases)("source nesting: %s", (kind) => {
  const { limit, code } = nestingBoundary(kind);
  it("compiles, executes and round-trips the deepest accepted source", () => {
    const source = nestingSource(kind, limit);
    const compiled = compileProject([source]);
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.ir).toBeDefined();
    const clock = new VirtualClock();
    const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
    runtime.load(compiled.ir!);
    const snapshot = runtime.scanOnce();
    expect(runtime.diagnostic).toBeNull();
    const index = compiled.ir!.variables.findIndex((variable) => variable.name.endsWith(".x"));
    expect(snapshot.variables[index]).toMatchObject({ kind: "scalar", value: 1 });
    const written = writeProject(nestingProject(source));
    expect(written.diagnostics).toEqual([]);
    const read = readProject(written.value!);
    expect(read.diagnostics).toEqual([]);
    expect(read.value!.pous).toEqual([source]);
    expect(compileProject(read.value!.pous).diagnostics).toEqual([]);
  });

  it("returns a source-limit diagnostic for the first rejected source", () => {
    const source = nestingSource(kind, limit + 1);
    const result = compileProject([source]);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code,
        severity: "error",
        pou: "Main",
        sourceIndex: 0,
        span: expect.any(Object),
        args: { limit },
      }),
    ]);
    expect(writeProject(nestingProject(source)).value).toBeNull();
  });
});

it.each(["parentheses", "if", "binary", "calls", "arrays", "initializers", "indices"] as const)(
  "rejects 10,000 levels of %s without overflowing the stack",
  (kind) => {
    expect(compileProject([nestingSource(kind, 10_000)]).diagnostics).toEqual([
      expect.objectContaining({ code: nestingBoundary(kind).code }),
    ]);
  },
);

it("checks iterative access chains before recursive root-name lookup", () => {
  for (const chain of ["^".repeat(10_000), ".a".repeat(10_000)]) {
    expect(parsePou(`PROGRAM Main a${chain}(); END_PROGRAM`).diagnostics).toEqual([
      expect.objectContaining({ code: "syntax.tree-depth-limit" }),
    ]);
  }
});

it("limits anonymous reference types in POU, type and return declarations", () => {
  for (const depth of [MAX_SOURCE_NESTING, MAX_SOURCE_NESTING + 1, 10_000]) {
    const type = "REF_TO ".repeat(depth) + "INT";
    const results = [
      parsePou(`PROGRAM Main VAR p : ${type}; END_VAR END_PROGRAM`),
      parsePou(`FUNCTION F : ${type} END_FUNCTION`),
      parseDataType(`TYPE T : ${type}; END_TYPE`),
    ];
    for (const result of results) {
      if (depth === MAX_SOURCE_NESTING) expect(result.diagnostics).toEqual([]);
      else
        expect(result.diagnostics).toEqual([
          expect.objectContaining({ code: "syntax.nesting-limit" }),
        ]);
    }
  }
});

it("checks named type sources and reports their source identity", () => {
  const main = "PROGRAM Main VAR a : Nested; END_VAR END_PROGRAM";
  for (const depth of [MAX_SOURCE_NESTING, MAX_SOURCE_NESTING + 1]) {
    const dataType = `TYPE Nested : ${"ARRAY[0..0] OF ".repeat(depth)}INT; END_TYPE`;
    const result = compileProject([main], [dataType]);
    if (depth === MAX_SOURCE_NESTING) {
      expect(result.diagnostics).toEqual([]);
      expect(
        readProject(writeProject(nestingProject(main, [dataType])).value!).value!.dataTypes,
      ).toEqual([dataType]);
    } else {
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "syntax.nesting-limit",
          pou: "Nested",
          sourceKind: "dataType",
          sourceIndex: 0,
        }),
      );
    }
  }
});

it("rejects excessive nesting imported in an XML ST body", () => {
  const source = nestingSource("parentheses", MAX_SOURCE_NESTING);
  const written = writeProject(nestingProject(source));
  expect(written.diagnostics).toEqual([]);
  // ST bodies and preserved source extensions both contain this exact expression.
  const expression = "(".repeat(MAX_SOURCE_NESTING) + "1" + ")".repeat(MAX_SOURCE_NESTING);
  const xml = written.value!.replaceAll(expression, `(${expression})`);
  const read = readProject(xml);
  expect(read.value).toBeNull();
  expect(read.diagnostics).toEqual([
    expect.objectContaining({ code: "syntax.nesting-limit", severity: "error" }),
  ]);
});

it("counts structure initializers at their nesting boundary", () => {
  for (const depth of [MAX_SOURCE_NESTING, MAX_SOURCE_NESTING + 1]) {
    for (const source of [
      `PROGRAM Main VAR s : S := ${"(a := ".repeat(depth)}1${")".repeat(depth)}; END_VAR END_PROGRAM`,
    ]) {
      const parsed = parsePou(source);
      if (depth === MAX_SOURCE_NESTING) expect(parsed.diagnostics).toEqual([]);
      else
        expect(parsed.diagnostics).toEqual([
          expect.objectContaining({ code: "syntax.nesting-limit" }),
        ]);
    }
  }
});

it("limits nested structure initializers and CASE label lookahead", () => {
  for (const expression of [
    "(a := ".repeat(10_000) + "1" + ")".repeat(10_000),
    "[".repeat(10_000) + "1" + "]".repeat(10_000),
  ]) {
    expect(
      parsePou(`PROGRAM Main VAR a : INT := ${expression}; END_VAR END_PROGRAM`).diagnostics,
    ).toEqual([expect.objectContaining({ code: "syntax.nesting-limit" })]);
  }
  expect(
    parsePou(
      `PROGRAM Main CASE 1 OF ${"(".repeat(33)}1${")".repeat(33)}: RETURN; END_CASE; END_PROGRAM`,
    ).diagnostics,
  ).toEqual([expect.objectContaining({ code: "syntax.nesting-limit" })]);
});

it("applies the same budget to configuration globals and connection expressions", () => {
  const expression = "(".repeat(MAX_SOURCE_NESTING + 1) + "1" + ")".repeat(MAX_SOURCE_NESTING + 1);
  const cases = [
    `VAR_GLOBAL x : INT := ${expression}; END_VAR RESOURCE Res ON Cpu TASK Cyclic(INTERVAL := T#10ms, PRIORITY := 1); PROGRAM mainInstance WITH Cyclic : Main; END_RESOURCE`,
    `RESOURCE Res ON Cpu TASK Cyclic(INTERVAL := T#10ms, PRIORITY := 1); PROGRAM mainInstance WITH Cyclic : Main(x := ${expression}); END_RESOURCE`,
  ];
  for (const body of cases) {
    const result = compileProject(
      ["PROGRAM Main END_PROGRAM"],
      [],
      `CONFIGURATION Config ${body} END_CONFIGURATION`,
    );
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "syntax.nesting-limit",
        sourceKind: "configuration",
        sourceIndex: 0,
      }),
    );
  }
});

it("does not limit named function block instance hierarchies", () => {
  const sources = ["FUNCTION_BLOCK B0 END_FUNCTION_BLOCK"];
  for (let depth = 1; depth <= MAX_SOURCE_NESTING + 1; depth++)
    sources.push(`FUNCTION_BLOCK B${depth} VAR child : B${depth - 1}; END_VAR END_FUNCTION_BLOCK`);
  sources.push(`PROGRAM Main VAR root : B${MAX_SOURCE_NESTING + 1}; END_VAR END_PROGRAM`);
  expect(compileProject(sources).diagnostics).toEqual([]);
});

describe.each(chainCases)("flat %s chains", (kind) => {
  it.each([33, MAX_SOURCE_TREE_DEPTH])("compiles and exchanges %i tree levels", (depth) => {
    const project = chainProject(kind, depth);
    const compiled = compileProject(project.pous, project.dataTypes);
    expect(compiled.diagnostics).toEqual([]);
    const clock = new VirtualClock();
    const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
    runtime.load(compiled.ir!);
    const snapshot = runtime.scanOnce();
    expect(runtime.diagnostic).toBeNull();
    const name = kind === "or" ? ".b" : ".x";
    const index = compiled.ir!.variables.findIndex((variable) => variable.name.endsWith(name));
    expect(snapshot.variables[index]).toMatchObject({
      kind: "scalar",
      value: kind === "or" ? false : 1,
    });
    const written = writeProject(project);
    expect(written.diagnostics).toEqual([]);
    const read = readProject(written.value!);
    expect(read.diagnostics).toEqual([]);
    expect(read.value!.pous).toEqual(project.pous);
    expect(compileProject(read.value!.pous, read.value!.dataTypes).diagnostics).toEqual([]);
  });

  it("rejects the first tree depth beyond the cap", () => {
    const project = chainProject(kind, MAX_SOURCE_TREE_DEPTH + 1);
    const parsed = parsePou(project.pous[0]!);
    expect(parsed.diagnostics).toEqual([
      expect.objectContaining({
        code: "syntax.tree-depth-limit",
        args: { limit: MAX_SOURCE_TREE_DEPTH },
      }),
    ]);
  });
});

it("shares the tree-depth budget between nested flat chains", () => {
  // Parenthesized groups plus one flat binary chain consume 32 syntax levels.
  const groups = MAX_SOURCE_NESTING - 1;
  for (const excess of [0, 1]) {
    const expression =
      "(".repeat(groups) +
      "x" +
      " + x".repeat(MAX_SOURCE_TREE_DEPTH - groups + excess) +
      ")".repeat(groups);
    const result = compileProject([
      `PROGRAM Main VAR x : DINT := 1; END_VAR x := ${expression}; END_PROGRAM`,
    ]);
    if (excess === 0) expect(result.diagnostics).toEqual([]);
    else
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: "syntax.tree-depth-limit" }),
      ]);
  }
});

it("reports an actionable diagnostic for an over-limit flat chain in XML", () => {
  const project = chainProject("sum", MAX_SOURCE_TREE_DEPTH);
  const written = writeProject(project);
  expect(written.diagnostics).toEqual([]);
  const expression = "1" + " + 0".repeat(MAX_SOURCE_TREE_DEPTH);
  const read = readProject(written.value!.replaceAll(expression, `${expression} + 0`));
  expect(read.value).toBeNull();
  expect(read.diagnostics).toEqual([
    expect.objectContaining({
      code: "syntax.tree-depth-limit",
      args: { limit: MAX_SOURCE_TREE_DEPTH },
    }),
  ]);
});

it("checks flat reference chains at the tree-depth boundary", () => {
  for (const depth of [MAX_SOURCE_TREE_DEPTH, MAX_SOURCE_TREE_DEPTH + 1]) {
    for (const chain of ["^".repeat(depth), ".a".repeat(depth), "[0]".repeat(depth)]) {
      const parsed = parsePou(`PROGRAM Main x := a${chain}; END_PROGRAM`);
      if (depth === MAX_SOURCE_TREE_DEPTH) expect(parsed.diagnostics).toEqual([]);
      else
        expect(parsed.diagnostics).toEqual([
          expect.objectContaining({ code: "syntax.tree-depth-limit" }),
        ]);
    }
  }
});

it("keeps diagnostics linear along an invalid flat enumeration chain", () => {
  const expression = "zz" + " = c".repeat(MAX_SOURCE_TREE_DEPTH);
  const result = compileProject(
    [`PROGRAM Main VAR c : Color; END_VAR c := ${expression}; END_PROGRAM`],
    ["TYPE Color : (Red, Green); END_TYPE"],
  );
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.length).toBeGreaterThan(0);
  expect(result.diagnostics.length).toBeLessThanOrEqual(MAX_SOURCE_TREE_DEPTH + 1);
  expect(
    result.diagnostics.filter((diagnostic) => diagnostic.code === "name.undeclared"),
  ).toHaveLength(1);
});

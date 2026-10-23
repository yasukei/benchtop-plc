import { describe, expect, it } from "vitest";
import {
  addFunction,
  addFunctionBlock,
  compilePous,
  createPous,
  deletePou,
  derivePou,
  diagnosticPouSourceIndex,
  initialPouIndex,
  pouSources,
  sameSources,
  uniqueFunctionName,
} from "./pous.js";

const main = "PROGRAM Main END_PROGRAM";
const fn = "FUNCTION F1 : INT F1 := 1; END_FUNCTION";

it("keeps data type and project diagnostics out of POU source locations", () => {
  const types = ["TYPE State : (Idle, Running) := State#Missing; END_TYPE"];
  const typeErrors = compilePous(createPous([main]), types).diagnostics;
  expect(typeErrors).toHaveLength(1);
  expect(typeErrors[0]).toMatchObject({ sourceKind: "dataType", sourceIndex: 0 });
  expect(typeErrors.map(diagnosticPouSourceIndex)).toEqual([undefined]);

  const pouErrors = compilePous(
    createPous([main, "FUNCTION F1 : INT F1 := missing; END_FUNCTION"]),
  ).diagnostics;
  expect(pouErrors).toHaveLength(1);
  expect(pouErrors.map(diagnosticPouSourceIndex)).toEqual([1]);
  expect(compilePous([]).diagnostics.map(diagnosticPouSourceIndex)).toEqual([undefined]);
});

describe("POU list operations", () => {
  it("preserves project order, chooses the program, and adds a compilable function", () => {
    const pous = createPous([fn, main]);
    expect(initialPouIndex(pous)).toBe(1);
    const added = addFunction(pous);
    expect(pouSources(added).slice(0, 2)).toEqual([fn, main]);
    expect(added[2]).toMatchObject({ name: "F2", kind: "FUNCTION" });
    expect(compilePous(added).ir).toBeDefined();
    expect(pous).toHaveLength(2);
  });

  it("derives names and kinds from headers, even with broken bodies and comments", () => {
    expect(derivePou("(* outer (* nested *) *) function MiXeD : INT missing := ;")).toMatchObject({
      name: "MiXeD",
      kind: "FUNCTION",
    });
    expect(derivePou("FUNCTION Renamed : INT @")).toMatchObject({
      name: "Renamed",
      kind: "FUNCTION",
    });
    expect(derivePou("FUNCTION_BLOCK Block END_FUNCTION_BLOCK")).toMatchObject({
      name: "Block",
      kind: "FUNCTION_BLOCK",
    });
    const previous = derivePou(fn);
    expect(derivePou("FUNCTION", previous)).toEqual({ ...previous, source: "FUNCTION" });
  });

  it("chooses unique names case insensitively and reserves names of damaged drafts", () => {
    const pous = createPous(["PROGRAM f1 END_PROGRAM", "FUNCTION f3 END_FUNCTION"]);
    expect(uniqueFunctionName(pous)).toBe("F2");
    const added = addFunction(pous);
    added[2] = derivePou("broken header", added[2]);
    expect(uniqueFunctionName(added)).toBe("F4");
  });

  it("protects every program and ignores invalid deletion indexes", () => {
    const pous = createPous([fn, main]);
    expect(deletePou(pous, 1)).toBe(pous);
    expect(deletePou(pous, -1)).toBe(pous);
    expect(deletePou(pous, 9)).toBe(pous);
    expect(pouSources(deletePou(pous, 0))).toEqual([main]);
  });

  it("tracks all sources while selection has no effect on whether work is applied", () => {
    expect(sameSources([main, fn], [main, fn])).toBe(true);
    expect(sameSources([main, fn], [main])).toBe(false);
    expect(sameSources([main, fn], [main, fn.replace("1;", "2;")])).toBe(false);
    expect(sameSources([main], null)).toBe(false);
  });

  it("locates semantic, duplicate-name, and damaged-header diagnostics by project order", () => {
    const semantic = compilePous(createPous([fn, "PROGRAM Main missing := 1; END_PROGRAM"]));
    expect(semantic.diagnostics).toContainEqual(
      expect.objectContaining({ code: "name.undeclared", sourceIndex: 1 }),
    );
    const duplicate = compilePous(createPous([main, fn, fn]));
    expect(duplicate.diagnostics).toContainEqual(
      expect.objectContaining({ code: "pou.duplicate", sourceIndex: 2 }),
    );
    const broken = compilePous([derivePou(main), derivePou("FUNCTION", derivePou(fn))]);
    expect(broken.diagnostics).toEqual([expect.objectContaining({ sourceIndex: 1 })]);
  });
});

it("routes checker diagnostics to the later same-named POU", () => {
  const result = compilePous(
    createPous([
      "PROGRAM Main END_PROGRAM",
      "FUNCTION Same : INT Same := 1; END_FUNCTION",
      "FUNCTION Same : INT Same := missing; END_FUNCTION",
    ]),
  );
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "pou.duplicate", sourceIndex: 2 }),
  );
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "name.undeclared", sourceIndex: 2 }),
  );
  expect(result.diagnostics.filter((diagnostic) => diagnostic.sourceIndex === 1)).toEqual([]);
});

it("adds a compilable function block with a unique case-insensitive name", () => {
  const pous = createPous([main, "FUNCTION fb1 END_FUNCTION"]);
  const added = addFunctionBlock(pous);
  expect(added.at(-1)).toMatchObject({ name: "FB2", kind: "FUNCTION_BLOCK" });
  expect(compilePous(added).diagnostics).toEqual([]);
  expect(addFunctionBlock(added).at(-1)?.name).toBe("FB3");
});

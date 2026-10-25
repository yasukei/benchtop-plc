import { describe, expect, it } from "vitest";
import {
  addDataType,
  createDataTypes,
  deriveDataType,
  deleteDataType,
  diagnosticSourceMatches,
  diagnosticPouIndex,
  addFunction,
  addFunctionBlock,
  addClass,
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

it("adds types in order with names shared with POUs and preserves damaged names", () => {
  const pous = createPous(["PROGRAM type1 END_PROGRAM"]);
  const types = addDataType([], pous);
  expect(types[0]).toMatchObject({ name: "Type2", kind: "TYPE" });
  expect(compilePous(pous, pouSources(types)).ir).toBeDefined();
  const renamed = deriveDataType("(* comment *) TYPE State : (Idle, Running); END_TYPE", types[0]);
  expect(renamed.name).toBe("State");
  expect(deriveDataType("TYPE", renamed)).toEqual({ ...renamed, source: "TYPE" });
  expect(deriveDataType("TYPE Renamed : @", renamed).name).toBe("Renamed");
  const damaged = deriveDataType("TYPE", types[0]);
  const added = addDataType([damaged], pous);
  expect(added.map((type) => type.name)).toEqual(["Type2", "Type3"]);
  expect(deleteDataType(added, 0)).toEqual([added[1]]);
  expect(deleteDataType(added, -1)).toBe(added);
  expect(deleteDataType(added, 9)).toBe(added);
  const reserved = createDataTypes(["TYPE f1 : INT; END_TYPE", "TYPE fb1 : INT; END_TYPE"]);
  expect(addFunction(pous, reserved).at(-1)?.name).toBe("F2");
  expect(addFunctionBlock(pous, reserved).at(-1)?.name).toBe("FB2");
});

it("keeps type and POU diagnostic locations separate even with the same index", () => {
  const result = compilePous(createPous(["PROGRAM Main missing := 1; END_PROGRAM"]), ["TYPE"]);
  const typeError = result.diagnostics.find((diagnostic) => diagnostic.sourceKind === "dataType")!;
  expect(typeError.sourceIndex).toBe(0);
  expect(diagnosticSourceMatches(typeError, 0, 0)).toBe(true);
  expect(diagnosticSourceMatches(typeError, 0, null)).toBe(false);
  expect(diagnosticSourceMatches({ ...typeError, sourceKind: "pou" }, 0, 0)).toBe(false);
});

it("templates every PROGRAM on one cyclic task without shared namespace collisions", async () => {
  const { configurationTemplate, deriveConfiguration } = await import("./pous.js");
  const pous = createPous([
    "PROGRAM Config END_PROGRAM",
    "PROGRAM Res END_PROGRAM",
    "FUNCTION Cyclic : INT Cyclic := 1; END_FUNCTION",
  ]);
  const types = createDataTypes(["TYPE mainInstance : INT; END_TYPE"]);
  const configuration = configurationTemplate(pous, types, null, 50);
  const result = compilePous(pous, pouSources(types), null, 50, configuration);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir?.resource.tasks).toMatchObject([{ intervalMs: 50 }]);
  expect(result.ir?.resource.programs).toMatchObject([
    { name: "mainInstance1", program: 0 },
    { name: "ResInstance", program: 1 },
  ]);
  expect(configuration.name).toBe("Config1");
  expect(deriveConfiguration("CONFIGURATION Renamed END_CONFIGURATION").name).toBe("Renamed");
  expect(deriveConfiguration("CONFIGURATION", configuration).name).toBe("Config1");
});

it("routes configuration diagnostics only to the configuration editor", () => {
  const diagnostic = {
    code: "syntax.unexpected-eof",
    severity: "error",
    args: {},
    sourceKind: "configuration",
    sourceIndex: 0,
  } as const;
  expect(diagnosticSourceMatches(diagnostic, 0, null, true)).toBe(true);
  expect(diagnosticSourceMatches(diagnostic, 0, null)).toBe(false);
  expect(diagnosticSourceMatches(diagnostic, 0, 0)).toBe(false);
  expect(diagnosticSourceMatches({ ...diagnostic, sourceKind: "pou" }, 0, null, true)).toBe(false);
});

it("locates method faults in the owning function block text", () => {
  expect(
    diagnosticPouIndex(createPous([main, "FUNCTION_BLOCK Counter END_FUNCTION_BLOCK"]), {
      code: "runtime.division-by-zero",
      severity: "error",
      args: {},
      pou: "Counter.Increment",
    }),
  ).toBe(1);
});

it("adds uniquely named classes with one public method", () => {
  const pous = createPous([main, "CLASS Class1 END_CLASS"]);
  const added = addClass(pous, createDataTypes(["TYPE Class2 : INT; END_TYPE"]));
  expect(added.at(-1)).toMatchObject({ name: "Class3", kind: "CLASS" });
  expect(added.at(-1)?.source).toContain("METHOD PUBLIC Run");
  expect(compilePous(added).diagnostics).toEqual([]);
  expect(deletePou(added, 2)).toEqual(pous);
});

it("adds an interface before POUs with one public prototype and a unique name", async () => {
  const { addInterface } = await import("./pous.js");
  const pous = createPous([main, "CLASS I1 END_CLASS"]);
  const added = addInterface(pous, createDataTypes(["TYPE I2 : INT; END_TYPE"]));
  expect(added[0]).toMatchObject({ name: "I3", kind: "INTERFACE" });
  expect(added[0]!.source).toContain("METHOD Run");
  expect(compilePous(added).diagnostics).toEqual([]);
  expect(deletePou(added, 0)).toEqual(pous);
});

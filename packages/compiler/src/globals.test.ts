import { expect, it } from "vitest";
import { compileProject } from "./index.js";

const configuration = (globals = "g : INT := 7;", resourceGlobals = "", constant = false) =>
  `CONFIGURATION Plant VAR_GLOBAL ${constant ? "CONSTANT" : ""} ${globals} END_VAR
   RESOURCE Station ON Cpu ${resourceGlobals ? `VAR_GLOBAL ${resourceGlobals} END_VAR` : ""}
   TASK T (INTERVAL := T#10ms, PRIORITY := 1); PROGRAM A WITH T : Main;
   END_RESOURCE END_CONFIGURATION`;
const program = (declarations = "VAR_EXTERNAL g : INT; END_VAR", body = "g := g + 1;") =>
  `PROGRAM Main ${declarations} ${body} END_PROGRAM`;
const compile = (
  pou = program(),
  config: string | undefined = configuration(),
  others: string[] = [],
  types: string[] = [],
) => compileProject([pou, ...others], types, config);

it("aliases externals to one global without allocating a second monitored variable", () => {
  const result = compile();
  expect(result.diagnostics).toEqual([]);
  expect(result.ir!.variables).toMatchObject([{ name: "g", initialValue: 7, global: true }]);
  expect(result.ir!.resource.programs[0]!.storage).toEqual([{ kind: "variable", variable: 0 }]);
  expect(JSON.parse(JSON.stringify(result.ir))).toEqual(result.ir);
});

it.each([
  [program("VAR_EXTERNAL missing : INT; END_VAR", ""), configuration(), "global.not-found"],
  [program("VAR_EXTERNAL g : DINT; END_VAR", ""), configuration(), "global.type-mismatch"],
  [
    program("VAR_EXTERNAL g : INT := 3; END_VAR", ""),
    configuration(),
    "global.external-initializer",
  ],
  [
    program("VAR_EXTERNAL CONSTANT g : INT; END_VAR", ""),
    configuration(),
    "global.constant-mismatch",
  ],
  [
    program("VAR_EXTERNAL g : INT; END_VAR", ""),
    configuration("g : INT := 2;", "", true),
    "global.constant-mismatch",
  ],
  [
    program("VAR_EXTERNAL CONSTANT g : INT; END_VAR"),
    configuration("g : INT := 2;", "", true),
    "decl.constant-not-writable",
  ],
  [
    program("VAR_EXTERNAL g : INT; END_VAR VAR g : INT; END_VAR", ""),
    configuration(),
    "decl.duplicate",
  ],
  [program("VAR g : INT; END_VAR", ""), configuration("g, G : INT;"), "config.name-collision"],
  [program("", ""), configuration("g : INT;", "G : INT;"), "config.name-collision"],
  [program("", ""), configuration("T : INT;"), "config.name-collision"],
  [program("", ""), configuration("Main : INT;"), "config.name-collision"],
  [program("", ""), configuration("ABS : INT;"), "config.name-collision"],
  [program("", ""), configuration("g : INT;", "Station : INT;"), "config.name-collision"],
  [program("", ""), configuration("g : INT;", "Plant : INT;"), "config.name-collision"],
  [program("", ""), configuration("g : INT;", "A : INT;"), "config.name-collision"],
])("rejects invalid external/global declarations (%s)", (pou, config, code) => {
  const result = compile(pou, config);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
});

it("rejects externals under the implicit configuration and in FUNCTIONs", () => {
  expect(compileProject([program()]).diagnostics).toContainEqual(
    expect.objectContaining({ code: "global.not-found" }),
  );
  expect(
    compile(program(), configuration(), [
      "FUNCTION F : INT VAR_EXTERNAL g : INT; END_VAR F := g; END_FUNCTION",
    ]).diagnostics,
  ).toContainEqual(
    expect.objectContaining({
      code: "pou.invalid-section",
      args: { kind: "function", section: "VAR_EXTERNAL" },
    }),
  );
});

it("keeps globals out of ordinary local scope and permits local shadowing", () => {
  expect(compile(program("", "g := 1;")).diagnostics).toContainEqual(
    expect.objectContaining({ code: "name.undeclared" }),
  );
  const result = compile(program("VAR g : INT := 2; END_VAR"));
  expect(result.diagnostics).toEqual([]);
  expect(result.ir!.variables.map((v) => v.name)).toEqual(["g", "A.g"]);
});

it("folds global constants in declaration order, external array bounds and CASE labels", () => {
  const result = compile(
    program(
      `VAR_EXTERNAL CONSTANT N : INT; END_VAR
    VAR a : ARRAY[1..N] OF INT; x : INT; END_VAR`,
      "CASE x OF N: x := 1; END_CASE;",
    ),
    configuration("First : INT := 2; N : INT := First + 1;", "", true),
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.ir!.variables.map((v) => v.name)).toEqual(["A.A[1]", "A.A[2]", "A.A[3]", "A.x"]);
  expect(
    compile(program("", ""), configuration("N : INT := Later; Later : INT := 3;", "", true))
      .diagnostics,
  ).toContainEqual(expect.objectContaining({ code: "decl.constant-order" }));
});

it("takes external string length from global storage and checks exact derived types", () => {
  const result = compile(
    program("VAR_EXTERNAL g : STRING[20]; END_VAR", "g := 'ok';"),
    configuration("g : STRING[5];"),
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.ir!.variables[0]).toMatchObject({ dataType: { kind: "string", length: 5 } });
  const types = [
    "TYPE Point : STRUCT X : INT; END_STRUCT; END_TYPE",
    "TYPE Other : STRUCT X : INT; END_STRUCT; END_TYPE",
  ];
  expect(
    compile(program("VAR_EXTERNAL g : Other; END_VAR", ""), configuration("g : Point;"), [], types)
      .diagnostics,
  ).toContainEqual(expect.objectContaining({ code: "global.type-mismatch" }));
});

it("accepts references to external scalar, array elements and structure members", () => {
  const result = compile(
    program(
      `VAR_EXTERNAL g : ARRAY[1..2] OF Point; END_VAR
    VAR r : REF_TO INT; END_VAR`,
      "r := REF(g[1].X); r^ := 9;",
    ),
    configuration("g : ARRAY[1..2] OF Point;"),
    [],
    ["TYPE Point : STRUCT X : INT; END_STRUCT; END_TYPE"],
  );
  expect(result.diagnostics).toEqual([]);
});

it.each(["TON", "ARRAY[1..2] OF TON"])(
  "selects a global %s from bindings across every POU",
  (type) => {
    const target = type.startsWith("ARRAY") ? "g[1]" : "g";
    const result = compile(
      program(`VAR_EXTERNAL g : ${type}; END_VAR`, `${target}(IN := TRUE);`),
      configuration(`g : ${type};`),
      [
        `FUNCTION_BLOCK Reader VAR_EXTERNAL g : ${type}; END_VAR ${target}(PT := LT#1s); END_FUNCTION_BLOCK`,
      ],
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ir!.variables[0]).toMatchObject({ kind: "functionBlock", fbType: "TON_LTIME" });
  },
);

it("checks all global FB-array dimensions and rejects different block types", () => {
  for (const type of ["ARRAY[1..3] OF TON", "ARRAY[1..2] OF CTU", "TON"]) {
    expect(
      compile(
        program(`VAR_EXTERNAL g : ${type}; END_VAR`, ""),
        configuration("g : ARRAY[1..2] OF TON;"),
      ).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: "global.type-mismatch" }));
  }
});

it("allows bit addresses on globals and rejects other address types and ranges", () => {
  expect(
    compile(program("VAR_EXTERNAL g : BOOL; END_VAR", ""), configuration("g AT %QX0.1 : BOOL;")).ir!
      .variables[0],
  ).toMatchObject({ address: { area: "Q", byte: 0, bit: 1 } });
  for (const [declaration, code] of [
    ["g AT %QX0.1 : INT;", "decl.direct-address-type"],
    ["g AT %IX1.0 : BOOL;", "decl.address-out-of-range"],
  ]) {
    expect(compile(program("", ""), configuration(declaration)).diagnostics).toContainEqual(
      expect.objectContaining({ code, sourceKind: "configuration" }),
    );
  }
});

it("allows an unused self-typed external but rejects recursive calls through it", () => {
  const main = program("VAR_EXTERNAL g : Block; END_VAR", "g();");
  const block = (body: string) =>
    `FUNCTION_BLOCK Block VAR_EXTERNAL g : Block; END_VAR ${body} END_FUNCTION_BLOCK`;
  expect(compile(main, configuration("g : Block;"), [block("")]).diagnostics).toEqual([]);
  expect(compile(main, configuration("g : Block;"), [block("g();")]).diagnostics).toContainEqual(
    expect.objectContaining({ code: "pou.recursion", pou: "Block" }),
  );
});

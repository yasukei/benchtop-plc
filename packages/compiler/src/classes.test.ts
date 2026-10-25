import { expect, it } from "vitest";
import { compileProject, parsePou, isKeyword } from "./index.js";

const valve = (members = "VAR opened: BOOL; END_VAR", methods = "") =>
  `CLASS Valve ${members} ${methods} END_CLASS`;
const main = (body = "", declarations = "v: Valve;") =>
  `PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`;
const configuration = `CONFIGURATION C VAR_GLOBAL globalValve: Valve; END_VAR
RESOURCE R ON Cpu TASK T (INTERVAL := T#10ms, PRIORITY := 0);
PROGRAM P WITH T : Main; END_RESOURCE END_CONFIGURATION`;

it("parses a bodyless class and shares the instance method IR", () => {
  const source = valve(
    undefined,
    `METHOD PUBLIC Open THIS.opened := TRUE; END_METHOD
    METHOD PUBLIC IsOpen : BOOL IsOpen := opened; END_METHOD`,
  );
  expect(parsePou(source).ast).toMatchObject({ kind: "class", body: [], methods: [{}, {}] });
  const result = compileProject([
    main("v.Open(); seen := v.IsOpen();", "v: Valve; seen: BOOL;"),
    source,
  ]);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir?.functionBlocks?.[0]).toMatchObject({
    kind: "class",
    body: [],
    inputs: [],
    outputs: [],
    temporaries: [],
    methods: [{}, {}],
  });
});

it.each(["VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT", "VAR_TEMP"])(
  "rejects %s even when empty",
  (section) => {
    const result = compileProject([main(), valve(`${section} END_VAR`)]);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "pou.invalid-section", args: { section, kind: "class" } }),
    );
  },
);

it.each([
  [main("v();"), "class.not-callable"],
  [main("v[1]();", "v: ARRAY[1..2] OF Valve;"), "class.not-callable"],
  [main("v.opened := TRUE;"), "fb.unknown-member"],
  [main("seen := v.opened;", "v: Valve; seen: BOOL;"), "fb.unknown-member"],
  [main("", "v: Valve := 1;"), "decl.fb-initializer"],
  [main("", "v: ARRAY[1..2] OF Valve := [1, 2];"), "decl.fb-initializer"],
  ["PROGRAM Main VAR_TEMP v: Valve; END_VAR END_PROGRAM", "fb.invalid-instance-section"],
  ["PROGRAM Main VAR_INPUT v: Valve; END_VAR END_PROGRAM", "fb.invalid-instance-section"],
  ["FUNCTION F VAR v: Valve; END_VAR END_FUNCTION", "pou.function-block-in-function"],
  ["FUNCTION F VAR_INPUT v: Valve; END_VAR END_FUNCTION", "fb.invalid-instance-section"],
  ["PROGRAM Main VAR CONSTANT v: Valve; END_VAR END_PROGRAM", "decl.constant-type"],
  ["PROGRAM Main VAR CONSTANT v: ARRAY[1..2] OF Valve; END_VAR END_PROGRAM", "decl.constant-type"],
  ["PROGRAM Main VAR valve: INT; END_VAR END_PROGRAM", "decl.name-collision"],
])("rejects invalid instance usage: %s", (source, code) => {
  const result = compileProject([source, valve()]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.map((d) => d.code)).toContain(code);
  if (code === "decl.name-collision")
    expect(result.diagnostics[0]?.args).toEqual({ name: "valve", kind: "type" });
});

it.each([
  ["VAR pin AT %IX0.0: BOOL; END_VAR", "pou.direct-address"],
  ["VAR self: Valve; END_VAR", "pou.recursion"],
  ["VAR self: ARRAY[1..2] OF Valve; END_VAR", "pou.recursion"],
  ["METHOD M VAR v: Valve; END_VAR END_METHOD", "pou.function-block-in-function"],
  ["METHOD M M(); END_METHOD", "pou.recursion"],
  ["METHOD M THIS(); END_METHOD", "method.this-call"],
  ["VAR PUBLIC PRIVATE x: INT; END_VAR", "access.duplicate"],
  ["VAR_EXTERNAL PUBLIC x: INT; END_VAR", "access.invalid-section"],
  ["opened := TRUE;", "class.body"],
])("rejects invalid class contents: %s", (text, code) => {
  const result = compileProject([main(), valve(text)]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.map((d) => d.code)).toContain(code);
});

it.each(["PUBLIC", "INTERNAL"])("allows %s variables and methods", (access) => {
  expect(
    compileProject([
      main("v.opened := TRUE; v.Open();"),
      valve(`VAR ${access} opened: BOOL; END_VAR`, `METHOD ${access} Open END_METHOD`),
    ]).diagnostics,
  ).toEqual([]);
});

it.each(["PRIVATE", "PROTECTED", ""])(
  "hides %s methods and members outside their type",
  (access) => {
    const result = compileProject([
      main("v.Open(); v.opened := TRUE;"),
      valve(`VAR ${access} opened: BOOL; END_VAR`, `METHOD ${access} Open END_METHOD`),
    ]);
    expect(result.diagnostics.map((d) => d.code)).toEqual(["access.hidden", "fb.unknown-member"]);
  },
);

it("checks private access by type and imports global instances into methods", () => {
  const result = compileProject(
    [
      main("v.Copy();"),
      valve(
        `VAR_EXTERNAL globalValve: Valve; END_VAR VAR PRIVATE opened: BOOL; END_VAR`,
        `METHOD PUBLIC Copy opened := globalValve.opened; END_METHOD`,
      ),
    ],
    [],
    configuration,
  );
  expect(result.diagnostics).toEqual([]);
});

it("allows instances in program, block and class VAR sections and globals", () => {
  const result = compileProject(
    [
      main("v.Open();", "v: Valve; items: ARRAY[1..2] OF Valve; o: Owner;"),
      valve(
        "VAR delay: TON; b: Block; END_VAR",
        "METHOD PUBLIC Open delay(IN := TRUE); b(); END_METHOD",
      ),
      "FUNCTION_BLOCK Block VAR other: Empty; END_VAR END_FUNCTION_BLOCK",
      "CLASS Owner VAR child: Valve; children: ARRAY[1..2] OF Valve; END_VAR END_CLASS",
      "CLASS Empty END_CLASS",
    ],
    [],
    configuration,
  );
  expect(result.diagnostics).toEqual([]);
});

it("rejects indirect containment across classes and function blocks", () => {
  const result = compileProject([
    main(),
    valve("VAR other: Block; END_VAR"),
    "FUNCTION_BLOCK Block VAR other: Valve; END_VAR END_FUNCTION_BLOCK",
  ]);
  expect(result.diagnostics.map((d) => d.code)).toContain("pou.recursion");
});

it.each(["Valve", "ARRAY[1..2] OF Valve"])("rejects %s structure members", (type) => {
  const result = compileProject(
    [main(), valve()],
    [`TYPE RecordType : STRUCT member: ${type}; END_STRUCT; END_TYPE`],
  );
  expect(result.diagnostics.map((d) => d.code)).toContain("decl.structure-member-type");
});

it("reserves CLASS and END_CLASS through the legacy opening path", () => {
  for (const word of ["Class", "End_Class"]) {
    expect(isKeyword(word)).toBe(true);
    const source = main("", `legacy, ${word}: INT;`);
    expect(parsePou(source).diagnostics[0]?.code).toBe("syntax.reserved-identifier");
    expect(parsePou(source, true).ast).not.toBeNull();
  }
});

it("allows public nested class instances as method receivers", () => {
  const result = compileProject([
    main("v.item.Open();"),
    valve("VAR PUBLIC item: Child; END_VAR"),
    "CLASS Child METHOD PUBLIC Open END_METHOD END_CLASS",
  ]);
  expect(result.diagnostics).toEqual([]);
});

it.each(["VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT", "VAR_TEMP"])(
  "rejects class instance arrays in %s",
  (section) => {
    const result = compileProject([
      `FUNCTION_BLOCK Holder ${section} items: ARRAY[1..2] OF Valve; END_VAR END_FUNCTION_BLOCK`,
      main(),
      valve(),
    ]);
    expect(result.diagnostics.map((d) => d.code)).toContain("fb.invalid-instance-section");
  },
);

it("reads and writes public nested scalar instance members", () => {
  const result = compileProject([
    main("v.item.x := 3; seen := v.item.x;", "v: Valve; seen: INT;"),
    valve("VAR PUBLIC item: Child; END_VAR"),
    "CLASS Child VAR PUBLIC x: INT; END_VAR END_CLASS",
  ]);
  expect(result.diagnostics).toEqual([]);
});

it("rejects calling a class array element nested inside a function block", () => {
  const result = compileProject([
    "PROGRAM Main VAR h: Holder; END_VAR h.items[1](); END_PROGRAM",
    "FUNCTION_BLOCK Holder VAR PUBLIC items: ARRAY[1..2] OF Valve; END_VAR END_FUNCTION_BLOCK",
    valve(),
  ]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.map((d) => d.code)).toContain("class.not-callable");
});

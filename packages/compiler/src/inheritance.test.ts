import { expect, it } from "vitest";
import { compileProject, isKeyword, parsePou } from "./index.js";
import { signatureTypes, signatureTypeSources } from "./signatures.test-support.js";

const main = (body = "", declarations = "d: Derived;") =>
  `PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`;
const base = (members = "", modifier = "") => `CLASS ${modifier} Base ${members} END_CLASS`;
const derived = (members = "", modifier = "") =>
  `CLASS ${modifier} Derived EXTENDS Base ${members} END_CLASS`;
const method = (
  prefix = "PUBLIC",
  result = "INT",
  parameters = "VAR_INPUT value: INT; END_VAR",
  body = result && !prefix.includes("ABSTRACT") ? "Check := Check;" : "",
) => `METHOD ${prefix} Check ${result ? `: ${result}` : ""} ${parameters} ${body} END_METHOD`;

it("resolves forward bases with stable base-first member and method slots", () => {
  const result = compileProject([
    main("d.Run();"),
    derived("VAR own: INT; END_VAR METHOD PUBLIC OVERRIDE Run SUPER.Run(); END_METHOD"),
    base(
      "VAR PRIVATE hidden: INT := 3; END_VAR METHOD PUBLIC Run hidden := hidden + 1; END_METHOD",
    ),
  ]);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir?.functionBlocks?.[0]).toMatchObject({
    base: 1,
    variables: [{ name: "hidden", initialValue: 3 }, { name: "own" }],
    methodTable: { RUN: 0 },
    methods: [{ declaringType: 0 }],
  });
  expect(JSON.parse(JSON.stringify(result.ir))).toEqual(result.ir);
});

it.each([
  [[main(), "CLASS Derived EXTENDS Missing END_CLASS"], "inheritance.unknown-base"],
  [[main(), "CLASS Derived EXTENDS INT END_CLASS"], "inheritance.unknown-base"],
  [[main(), "CLASS Derived EXTENDS Main END_CLASS"], "inheritance.base-kind"],
  [
    [main(), "FUNCTION_BLOCK Derived EXTENDS Base END_FUNCTION_BLOCK", base()],
    "inheritance.base-kind",
  ],
  [[main(), derived(), "FUNCTION_BLOCK Base END_FUNCTION_BLOCK"], "inheritance.base-kind"],
  [[main(), derived(), "CLASS Base EXTENDS Derived END_CLASS"], "inheritance.cycle"],
  [[main(), "CLASS Derived EXTENDS Derived END_CLASS"], "inheritance.cycle"],
  [[main(), derived(), base("", "FINAL")], "inheritance.final-base"],
  [
    [main(), derived("VAR x: INT; END_VAR"), base("VAR PRIVATE x: INT; END_VAR")],
    "inheritance.member-collision",
  ],
  [
    [main(), derived("METHOD x END_METHOD"), base("VAR x: INT; END_VAR")],
    "inheritance.member-collision",
  ],
  [[main(), derived("VAR Check: INT; END_VAR"), base(method())], "inheritance.member-collision"],
  [[main(), derived(method()), base(method())], "inheritance.override-required"],
  [[main(), derived(method("PUBLIC OVERRIDE")), base()], "inheritance.override-missing"],
  [
    [main(), derived(method("PRIVATE OVERRIDE")), base(method("PRIVATE"))],
    "inheritance.override-private",
  ],
  [
    [main(), derived(method("PUBLIC OVERRIDE")), base(method("PUBLIC FINAL"))],
    "inheritance.override-final",
  ],
  [[main(), derived(method("PROTECTED OVERRIDE")), base(method())], "inheritance.override-access"],
  [
    [main(), derived(method("PUBLIC OVERRIDE", "BOOL")), base(method())],
    "inheritance.override-signature",
  ],
  [
    [main(), derived(method("PUBLIC OVERRIDE", "")), base(method())],
    "inheritance.override-signature",
  ],
  [
    [
      main(),
      derived(method("PUBLIC OVERRIDE", "INT", "VAR_INPUT other: INT; END_VAR")),
      base(method()),
    ],
    "inheritance.override-signature",
  ],
  [
    [
      main(),
      derived(method("PUBLIC OVERRIDE", "INT", "VAR_OUTPUT value: INT; END_VAR")),
      base(method()),
    ],
    "inheritance.override-signature",
  ],
  [
    [
      main(),
      derived(method("PUBLIC OVERRIDE", "INT", "VAR_INPUT value: DINT; END_VAR")),
      base(method()),
    ],
    "inheritance.override-signature",
  ],
  [
    [main(), derived(), base("", "ABSTRACT"), "PROGRAM Other VAR b: Base; END_VAR END_PROGRAM"],
    "inheritance.abstract-instance",
  ],
  [
    [main("", "d: ARRAY[1..2] OF Derived;"), derived("", "ABSTRACT"), base()],
    "inheritance.abstract-instance",
  ],
  [[main(), derived(), base(method("PUBLIC ABSTRACT"))], "inheritance.abstract-method"],
  [
    [
      main(),
      derived(method("PUBLIC OVERRIDE")),
      base(method("PUBLIC ABSTRACT", "INT", "", "RETURN;"), "ABSTRACT"),
    ],
    "inheritance.abstract-method",
  ],
  [
    [main(), derived(method("PRIVATE OVERRIDE")), base(method("PRIVATE ABSTRACT"), "ABSTRACT")],
    "inheritance.abstract-private",
  ],
  [
    [main(), derived(), base(method("PUBLIC ABSTRACT"), "ABSTRACT")],
    "inheritance.abstract-unimplemented",
  ],
  [
    [main("", ""), "FUNCTION_BLOCK ABSTRACT B RETURN; END_FUNCTION_BLOCK"],
    "inheritance.abstract-body",
  ],
  [[main("SUPER.Run();"), derived(), base()], "inheritance.super-context"],
  [[main(), derived("METHOD Run SUPER.Missing(); END_METHOD"), base()], "inheritance.super-method"],
  [
    [
      main(),
      derived(method("PUBLIC OVERRIDE", "INT", undefined, "Check := SUPER.Check(1);")),
      base(method("PUBLIC ABSTRACT"), "ABSTRACT"),
    ],
    "inheritance.super-method",
  ],
  [
    [main(), derived("METHOD Run SUPER.Check(1); END_METHOD"), base(method("PRIVATE"))],
    "inheritance.super-method",
  ],
  [[main(), derived("METHOD Run SUPER(); END_METHOD"), base()], "inheritance.super-body"],
  [
    [main(), derived("METHOD Run SUPER.Run(); END_METHOD"), "CLASS Base END_CLASS"],
    "inheritance.super-method",
  ],
  [
    [main(), "CLASS Derived METHOD Run SUPER.Run(); END_METHOD END_CLASS"],
    "inheritance.super-context",
  ],
  [[main("SUPER();"), derived(), base()], "inheritance.super-body"],
  [
    [main("", "d: Derived;"), "FUNCTION_BLOCK Derived SUPER(); END_FUNCTION_BLOCK"],
    "inheritance.super-body",
  ],
  [
    [
      main(),
      "FUNCTION_BLOCK Derived EXTENDS Base SUPER(1); END_FUNCTION_BLOCK",
      "FUNCTION_BLOCK Base END_FUNCTION_BLOCK",
    ],
    "inheritance.super-body",
  ],
  [
    [
      main(),
      "FUNCTION_BLOCK Derived EXTENDS Base SUPER(X := 1); END_FUNCTION_BLOCK",
      "FUNCTION_BLOCK Base END_FUNCTION_BLOCK",
    ],
    "inheritance.super-body",
  ],
])("rejects invalid inheritance (%s)", (sources, code) => {
  const result = compileProject(sources);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.map((d) => d.code)).toContain(code);
});

it.each([
  "CLASS ABSTRACT FINAL A END_CLASS",
  "FUNCTION_BLOCK FINAL ABSTRACT A END_FUNCTION_BLOCK",
  "CLASS A METHOD PUBLIC ABSTRACT FINAL M END_METHOD END_CLASS",
  "CLASS A METHOD PUBLIC OVERRIDE FINAL M END_METHOD END_CLASS",
  "CLASS A EXTENDS B FINAL END_CLASS",
])("enforces modifier/header order: %s", (source) => {
  expect(parsePou(source).ast).toBeNull();
});

it.each([
  "hiddenValue := 2;",
  "THIS.hiddenValue := 2;",
  "x := secret;",
  "Hidden();",
  "THIS.Hidden();",
])("hides inherited PRIVATE declarations: %s", (body) => {
  const result = compileProject([
    main(),
    derived(`METHOD Run VAR x: INT; END_VAR ${body} END_METHOD`),
    base(
      "VAR PRIVATE hiddenValue: INT; END_VAR VAR PRIVATE CONSTANT secret: INT := 3; END_VAR METHOD PRIVATE Hidden END_METHOD",
    ),
  ]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.map((d) => d.code)).toContain("access.hidden");
});

it("inherits protected members, constants and methods across several levels", () => {
  const result = compileProject([
    main("d.Run();"),
    derived("METHOD PUBLIC Run n := ceiling; THIS.Add(); END_METHOD"),
    "CLASS Base EXTENDS Root END_CLASS",
    "CLASS Root VAR n: INT; END_VAR VAR CONSTANT ceiling: INT := 4; END_VAR METHOD Add n := n + 1; END_METHOD END_CLASS",
  ]);
  expect(result.diagnostics).toEqual([]);
});

it("allows an abstract chain with a concrete final override and local declarations", () => {
  const result = compileProject([
    main(),
    derived(
      method(
        "PUBLIC FINAL OVERRIDE",
        "INT",
        "VAR_INPUT value: INT := 4; END_VAR VAR local: INT; END_VAR",
        "Check := value;",
      ),
      "FINAL",
    ),
    base(method("PUBLIC ABSTRACT"), "ABSTRACT"),
  ]);
  expect(result.diagnostics).toEqual([]);
});

it.each(["Check();", "THIS.Check();"])(
  "rejects dynamic recursion through %s and SUPER.Start",
  (call) => {
    const result = compileProject([
      main(),
      derived("METHOD PUBLIC OVERRIDE Check SUPER.Start(); END_METHOD"),
      base(`METHOD PUBLIC Start ${call} END_METHOD METHOD PUBLIC Check END_METHOD`),
    ]);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.map((d) => d.code)).toContain("pou.recursion");
  },
);

it.each([
  ["parameter order", "x,y: INT;", "y,x: INT;", false],
  ["string capacities", "x: STRING[3];", "x: STRING[4];", true],
  ["array bounds", "x: ARRAY[1..2] OF INT;", "x: ARRAY[0..1] OF INT;", false],
])("compares %s in override signatures", (_detail, a, b, matches) => {
  const result = compileProject([
    main(),
    derived(method("PUBLIC OVERRIDE", "INT", `VAR_INPUT ${a} END_VAR`)),
    base(method("PUBLIC", "INT", `VAR_INPUT ${b} END_VAR`)),
  ]);
  expect(result.diagnostics.map((d) => d.code)).toEqual(
    matches ? [] : ["inheritance.override-signature"],
  );
});

it.each(["Extends", "Override", "Super", "Abstract", "Final"])(
  "reserves %s with the legacy import path",
  (word) => {
    expect(isKeyword(word)).toBe(true);
    const text = main("", `${word}: INT;`);
    expect(parsePou(text).diagnostics[0]?.code).toBe("syntax.reserved-identifier");
    expect(parsePou(text, true).ast).not.toBeNull();
  },
);

it.each(["bits.bitNo := TRUE;", "THIS.bits.bitNo := TRUE;"])(
  "hides inherited PRIVATE constants used as bit indices: %s",
  (body) => {
    const result = compileProject([
      main(),
      derived(`METHOD Run ${body} END_METHOD`),
      base("VAR PRIVATE CONSTANT bitNo: INT := 1; END_VAR VAR bits: BYTE; END_VAR"),
    ]);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.map((d) => d.code)).toContain("access.hidden");
  },
);

it.each([
  ["VAR x: Missing; END_VAR", "decl.unknown-type"],
  ["VAR x: INT := 40000; END_VAR", "type.invalid-constant"],
  ["VAR_INPUT END_VAR", "pou.invalid-section"],
  ["VAR RETAIN NON_RETAIN END_VAR", "decl.retention-conflict"],
])("reports invalid base declarations only in their declaring source: %s", (members, code) => {
  const result = compileProject([
    main("", ""),
    derived(),
    base(members),
    "CLASS Leaf EXTENDS Derived END_CLASS",
  ]);
  expect(result.ir).toBeUndefined();
  const errors = result.diagnostics.filter((d) => d.code === code);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({ pou: "Base", sourceIndex: 2 });
  expect(result.diagnostics.every((d) => d.sourceIndex === 2)).toBe(true);
});

it("keeps a derived declaration's own diagnostics when its base is invalid", () => {
  const result = compileProject([
    main("", ""),
    derived("VAR y: AlsoMissing; END_VAR"),
    base("VAR x: Missing; END_VAR"),
  ]);
  expect(result.ir).toBeUndefined();
  expect(
    result.diagnostics.map(({ code, pou, sourceIndex }) => ({ code, pou, sourceIndex })),
  ).toEqual([
    { code: "decl.unknown-type", pou: "Derived", sourceIndex: 1 },
    { code: "decl.unknown-type", pou: "Base", sourceIndex: 2 },
  ]);
});

it.each(signatureTypes)(
  "compares override $position types using $name equivalence (matches: $matches)",
  ({ left, right, matches, position }) => {
    const signature = (prefix: string, type: string) =>
      method(
        prefix,
        position === "result" ? type : "",
        position === "result" ? "" : `${position} value: ${type}; END_VAR`,
      );
    const result = compileProject(
      [main(), derived(signature("PUBLIC OVERRIDE", left)), base(signature("PUBLIC", right))],
      signatureTypeSources,
    );
    if (matches) {
      expect(result.diagnostics).toEqual([]);
      expect(result.ir).toBeDefined();
    } else {
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics.map((d) => d.code)).toEqual(["inheritance.override-signature"]);
    }
  },
);

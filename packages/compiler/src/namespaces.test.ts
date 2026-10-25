import { describe, expect, it } from "vitest";
import { compileProject, parsePou, parseDataType } from "./index.js";

const wrap = (namespace: string, source: string, using = "") =>
  `NAMESPACE ${namespace}\n${using}\n${source}\nEND_NAMESPACE`;
const motor = (namespace: string, modifier = "") =>
  wrap(namespace, `CLASS ${modifier} Motor VAR PUBLIC speed: INT; END_VAR END_CLASS`);
const main = (type: string, using = "") =>
  `${using}\nPROGRAM Main VAR m: ${type}; END_VAR END_PROGRAM`;
const codes = (sources: string[], types: string[] = []) =>
  compileProject(sources, types).diagnostics.map((d) => d.code);

describe("namespace syntax and lookup", () => {
  it("qualifies declarations while preserving spans and simple names", () => {
    expect(parsePou(motor("A.B")).ast).toMatchObject({
      name: { name: "A.B.Motor" },
      simpleName: { name: "Motor" },
      namespace: { key: "A.B" },
    });
    expect(parseDataType(wrap("A", "TYPE INTERNAL Count : INT; END_TYPE")).ast).toMatchObject({
      name: { name: "A.Count" },
      internal: true,
    });
  });
  it.each([
    "NAMESPACE A NAMESPACE B CLASS C END_CLASS END_NAMESPACE END_NAMESPACE",
    "NAMESPACE A CLASS C END_CLASS CLASS D END_CLASS END_NAMESPACE",
    "NAMESPACE INTERNAL CLASS C END_CLASS END_NAMESPACE",
    "CLASS C USING A; END_CLASS",
  ])("rejects invalid source structure: %s", (source) => expect(parsePou(source).ast).toBeNull());
  it("rejects a namespaced configuration", () => {
    expect(
      compileProject(
        ["PROGRAM Main END_PROGRAM"],
        [],
        wrap("A", "CONFIGURATION C END_CONFIGURATION"),
      ).ir,
    ).toBeUndefined();
  });
  it("resolves qualified types globally and simple types via USING", () => {
    expect(codes([main("A.Motor"), motor("A")])).toEqual([]);
    expect(codes([main("Motor", "USING A;"), motor("A")])).toEqual([]);
    expect(codes([wrap("A", main("B.Motor")), motor("A.B"), motor("B")])).toEqual([]);
  });
  it("searches own namespace, then enclosing namespaces, before imports/global", () => {
    const result = compileProject([
      wrap("A.B", main("Motor", "USING X;")),
      motor("A.B"),
      motor("A"),
      motor("X"),
      "CLASS Motor END_CLASS",
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.instances?.[0]?.block).toBe(0);
    expect(codes([wrap("A.B", main("Motor", "USING X;")), motor("A"), motor("X")])).toEqual([]);
  });
  it("makes imports ambiguous together with global declarations", () => {
    expect(codes([main("Motor", "USING A, B;"), motor("A"), motor("B")])).toContain(
      "namespace.ambiguous",
    );
    expect(codes([main("Motor", "USING A;"), motor("A"), "CLASS Motor END_CLASS"])).toContain(
      "namespace.ambiguous",
    );
    expect(codes([main("Motor", "USING A, A;"), motor("A")])).toEqual([]);
  });
  it("diagnoses unknown imports and qualified names", () => {
    expect(codes([main("A.B.Missing")])).toContain("namespace.unknown");
    expect(codes([main("INT", "USING Missing;")])).toContain("namespace.unknown");
  });
  it("resolves EXTENDS, IMPLEMENTS, result types and qualified function calls", () => {
    expect(
      codes(
        [
          main("A.Derived"),
          wrap(
            "A",
            "CLASS Derived EXTENDS Base IMPLEMENTS I METHOD PUBLIC Value : Count Value := Lib.Get(); END_METHOD END_CLASS",
            "USING Lib;",
          ),
          wrap("Lib", "CLASS Base END_CLASS"),
          wrap("Lib", "INTERFACE I METHOD Value : Count END_METHOD END_INTERFACE"),
          wrap("Lib", "FUNCTION Get : Count Get := 7; END_FUNCTION"),
        ],
        [wrap("Lib", "TYPE Count : INT; END_TYPE")],
      ),
    ).toEqual([]);
  });
  it("keeps local function block calls ahead of POU lookup", () => {
    expect(
      codes([
        wrap("A", "PROGRAM Main VAR block: B; END_VAR block(); END_PROGRAM"),
        wrap("A", "FUNCTION_BLOCK B END_FUNCTION_BLOCK"),
      ]),
    ).toEqual([]);
  });
});

describe("namespace access and names", () => {
  it("limits INTERNAL declarations to the namespace and descendants", () => {
    for (const ns of ["A", "A.B"])
      expect(codes([wrap(ns, main("A.Motor")), motor("A", "INTERNAL")])).toEqual([]);
    for (const ns of ["B", "AB"])
      expect(codes([wrap(ns, main("A.Motor")), motor("A", "INTERNAL")])).toContain(
        "namespace.internal",
      );
    expect(codes([main("A.Motor"), motor("A", "INTERNAL")])).toContain("namespace.internal");
    expect(codes([main("Helper"), "CLASS INTERNAL Helper END_CLASS"])).toContain(
      "namespace.internal-global",
    );
  });
  it("checks INTERNAL members and methods against the declaring namespace", () => {
    const type = wrap(
      "A",
      "CLASS C VAR INTERNAL value: INT; END_VAR METHOD INTERNAL Run END_METHOD END_CLASS",
    );
    const body =
      "PROGRAM Main VAR obj: A.C; x: INT; END_VAR obj.Run(); x := obj.value; END_PROGRAM";
    expect(codes([wrap("A.B", body), type])).toEqual([]);
    expect(codes([wrap("B", body), type])).toContain("access.hidden");
    expect(
      codes([
        body.replace("A.C", "C"),
        "CLASS C METHOD INTERNAL Run END_METHOD VAR END_VAR END_CLASS",
      ]),
    ).not.toEqual([]);
    expect(
      codes([
        "PROGRAM Main VAR obj: C; END_VAR obj.Run(); END_PROGRAM",
        "CLASS C METHOD INTERNAL Run END_METHOD END_CLASS",
      ]),
    ).toEqual([]);
  });
  it.each(["PROGRAM A END_PROGRAM", "PROGRAM Main VAR A: INT; END_VAR END_PROGRAM"])(
    "reserves the first namespace segment: %s",
    (source) => {
      expect(codes([source, motor("A.B")])).toContain("decl.name-collision");
    },
  );
  it("forbids a declaration equal to a namespace and standard simple names", () => {
    expect(codes([main("INT"), wrap("A", "CLASS B END_CLASS"), motor("A.B")])).toContain(
      "decl.name-collision",
    );
    expect(codes([main("INT"), wrap("A", "CLASS TON END_CLASS")])).toContain("decl.name-collision");
  });
  it("only reserves a namespaced type's simple name where visible", () => {
    const source = "PROGRAM Main VAR Motor: INT; END_VAR END_PROGRAM";
    expect(codes([source, motor("A")])).toEqual([]);
    expect(codes([wrap("A", source), motor("A")])).toContain("decl.name-collision");
    expect(codes([`USING A; ${source}`, motor("A")])).toContain("decl.name-collision");
  });
});

it("qualifies nested type syntax and enum prefixes", () => {
  const result = compileProject(
    [
      "USING Lib; PROGRAM Main VAR items: ARRAY[1..2] OF Count; r: REF_TO Lib.Count; modeValue: Mode; END_VAR modeValue := Lib.Mode#Running; END_PROGRAM",
    ],
    [
      wrap("Lib", "TYPE Count : INT; END_TYPE"),
      wrap("Lib", "TYPE Mode : (Idle, Running); END_TYPE"),
    ],
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.ir?.types?.map((type) => type.name)).toEqual(["Lib.Count", "Lib.Mode"]);
});

it("keeps imported type names lexical inside inherited method bodies", () => {
  expect(
    codes([
      main("Other.Derived"),
      wrap("Other", "CLASS Derived EXTENDS Lib.Base END_CLASS"),
      wrap(
        "Lib",
        "CLASS Base VAR device: Child; END_VAR METHOD PUBLIC Run device.Tick(); END_METHOD END_CLASS",
      ),
      wrap("Lib", "CLASS Child METHOD PUBLIC Tick END_METHOD END_CLASS"),
      wrap("Other", "FUNCTION Child : INT Child := 1; END_FUNCTION"),
    ]),
  ).toEqual([]);
});

it.each([
  "TYPE INTERNAL Count : INT; END_TYPE",
  "INTERFACE INTERNAL I END_INTERFACE",
  "FUNCTION INTERNAL F : INT F := 1; END_FUNCTION",
  "FUNCTION_BLOCK INTERNAL B END_FUNCTION_BLOCK",
  "PROGRAM INTERNAL Inner END_PROGRAM",
])("limits every declaration kind: %s", (declaration) => {
  const ast = declaration.startsWith("TYPE")
    ? parseDataType(wrap("A", declaration)).ast
    : parsePou(wrap("A", declaration)).ast;
  expect(ast?.internal).toBe(true);
  expect(ast?.name.name.startsWith("A.")).toBe(true);
});

it("resolves imported functions in statement calls, including formal inputs", () => {
  expect(
    codes([
      "USING Lib; PROGRAM Main Emit(); Consume(value := 2); Lib.Emit(); END_PROGRAM",
      wrap("Lib", "FUNCTION Emit END_FUNCTION"),
      wrap("Lib", "FUNCTION Consume VAR_INPUT value: INT; END_VAR END_FUNCTION"),
    ]),
  ).toEqual([]);
});

it("rejects self recursion in a namespaced function by its simple call name", () => {
  expect(codes([main("INT"), wrap("Lib", "FUNCTION F : INT F := F(); END_FUNCTION")])).toContain(
    "pou.recursion",
  );
});

it("keeps syntax diagnostic source names qualified", () => {
  expect(
    compileProject([wrap("Lib", "PROGRAM Main VAR x: INT; END_VAR x := ; END_PROGRAM")])
      .diagnostics[0],
  ).toMatchObject({ pou: "Lib.Main", sourceIndex: 0 });
  expect(
    compileProject(["PROGRAM Main END_PROGRAM"], [wrap("Lib", "TYPE Count : ; END_TYPE")])
      .diagnostics[0],
  ).toMatchObject({ pou: "Lib.Count", sourceKind: "dataType", sourceIndex: 0 });
});

it.each([false, true])(
  "preserves nested THIS receivers in block bodies and class methods (namespace: %s)",
  (namespaced) => {
    const scope = (source: string) => (namespaced ? wrap("Lib", source) : source);
    expect(
      codes([
        main(namespaced ? "Lib.OuterBlock" : "OuterBlock"),
        scope(
          "FUNCTION_BLOCK Inner METHOD PUBLIC Run END_METHOD METHOD PUBLIC Value : INT Value := 7; END_METHOD END_FUNCTION_BLOCK",
        ),
        scope(
          "FUNCTION_BLOCK OuterBlock VAR part: Inner; result: INT; END_VAR THIS.part.Run(); result := THIS.part.Value(); END_FUNCTION_BLOCK",
        ),
        scope(
          "CLASS OuterClass VAR part: Inner; END_VAR METHOD PUBLIC Run THIS.part.Run(); END_METHOD METHOD PUBLIC Value : INT Value := THIS.part.Value(); END_METHOD END_CLASS",
        ),
      ]),
    ).toEqual([]);
  },
);

it("keeps missing instance diagnostics separate from known namespace lookups", () => {
  const missing = compileProject(["PROGRAM Main motr.Run(); END_PROGRAM"]);
  expect(missing.diagnostics).toContainEqual(
    expect.objectContaining({ code: "name.undeclared", args: { name: "motr" } }),
  );
  expect(missing.diagnostics.map((d) => d.code)).not.toContain("namespace.unknown");
  expect(codes(["PROGRAM Main Lib.Missing(); END_PROGRAM", motor("Lib")])).toContain(
    "namespace.unknown",
  );
});

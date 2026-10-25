import { expect, it } from "vitest";
import { compileProject, parsePou } from "./index.js";

export const actuator = `INTERFACE IActuator
METHOD Start END_METHOD
METHOD Value : INT END_METHOD
END_INTERFACE`;
export const valve = `CLASS Valve IMPLEMENTS IActuator
VAR count: INT; END_VAR
METHOD PUBLIC Start count := count + 1; END_METHOD
METHOD PUBLIC Value : INT Value := count; END_METHOD
END_CLASS`;
const main = (declarations = "", body = "") =>
  `PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`;
const codes = (sources: string[], types: string[] = []) => {
  const compiled = compileProject(sources, types);
  expect(compiled.ir).toBeUndefined();
  return compiled.diagnostics.map((d) => d.code);
};

it("represents interfaces, extending interfaces, inherited implementations and reference leaves", () => {
  const result = compileProject([
    main(
      "v: Derived; a: IActuator; b: IDerived; arr: ARRAY[1..2] OF IActuator;",
      "a := v; b := v; a := b; a.Start(); arr[1] := a;",
    ),
    actuator,
    "INTERFACE IDerived EXTENDS IActuator END_INTERFACE",
    valve.replace("IActuator", "IDerived"),
    "CLASS Derived EXTENDS Valve END_CLASS",
  ]);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir?.interfaces).toHaveLength(2);
  expect(result.ir?.functionBlocks?.[1]?.interfaces).toEqual(["IDERIVED", "IACTUATOR"]);
  expect(result.ir?.variables.filter((v) => v.kind === "reference")).toHaveLength(4);
  expect(JSON.parse(JSON.stringify(result.ir))).toEqual(result.ir);
});

it.each([
  ["CLASS Bad IMPLEMENTS IActuator END_CLASS", "interface.unimplemented"],
  [valve.replace("PUBLIC Start", "PROTECTED Start"), "interface.unimplemented"],
  [
    valve.replace("Value : INT", "Value : BOOL").replace("Value := count", "Value := TRUE"),
    "interface.unimplemented",
  ],
  ["CLASS Bad IMPLEMENTS Missing END_CLASS", "interface.unknown"],
  ["INTERFACE Bad EXTENDS Missing END_INTERFACE", "interface.unknown"],
  ["INTERFACE Bad EXTENDS Bad END_INTERFACE", "interface.cycle"],
  ["INTERFACE Bad EXTENDS Other END_INTERFACE", "interface.cycle"],
])("rejects invalid interface declarations: %s", (source, code) => {
  expect(
    codes([
      main(),
      actuator,
      source,
      ...(source.includes("EXTENDS Other") ? ["INTERFACE Other EXTENDS Bad END_INTERFACE"] : []),
    ]),
  ).toContain(code);
});

it("allows missing prototypes in abstract types and requires derived concrete implementations", () => {
  const base = "CLASS ABSTRACT Base IMPLEMENTS IActuator END_CLASS";
  expect(compileProject([main(), actuator, base]).diagnostics).toEqual([]);
  expect(codes([main(), actuator, base, "CLASS Bad EXTENDS Base END_CLASS"])).toContain(
    "interface.unimplemented",
  );
});

it.each([
  ["a := unrelated;", "type.assign-mismatch"],
  ["a := 2;", "type.assign-mismatch"],
  ["a.Unknown();", "method.unknown"],
  ["a^ := 1;", "type.invalid-reference-target"],
  ["a();", "fb.not-function-block"],
  ["n := a.count;", "fb.not-function-block"],
  ["a ?= 1;", "interface.assignment-attempt"],
  ["n ?= a;", "interface.assignment-attempt"],
  ["a := b;", "type.assign-mismatch"],
])("rejects invalid interface use: %s", (body, code) => {
  expect(
    codes([
      main("a: IActuator; b: IEmpty; v: Valve; unrelated: Other; n: INT;", body),
      actuator,
      "INTERFACE IEmpty END_INTERFACE",
      valve,
      "CLASS Other END_CLASS",
    ]),
  ).toContain(code);
});

it.each([
  "VAR CONSTANT a: IActuator; END_VAR",
  "VAR a AT %MW0: IActuator; END_VAR",
  "VAR a: IActuator := 0; END_VAR",
  "VAR IActuator: INT; END_VAR",
])("rejects forbidden declarations: %s", (section) => {
  expect(compileProject([`PROGRAM Main ${section} END_PROGRAM`, actuator]).ir).toBeUndefined();
});

it.each([
  "INTERFACE I VAR a: INT; END_VAR END_INTERFACE",
  "INTERFACE I METHOD PUBLIC Run END_METHOD END_INTERFACE",
  "INTERFACE I METHOD Run VAR a: INT; END_VAR END_METHOD END_INTERFACE",
  "INTERFACE I METHOD Run Run(); END_METHOD END_INTERFACE",
])("rejects non-prototype interface contents: %s", (source) => {
  expect(parsePou(source).diagnostics.length).toBeGreaterThan(0);
});

it("checks inherited prototype signatures and accepts matching diamonds", () => {
  const a = "INTERFACE IA METHOD Run VAR_INPUT x: INT; END_VAR END_METHOD END_INTERFACE";
  const b = "INTERFACE IB EXTENDS IA END_INTERFACE";
  const c = "INTERFACE IC EXTENDS IA END_INTERFACE";
  const d = "INTERFACE ID EXTENDS IB, IC END_INTERFACE";
  expect(compileProject([main(), a, b, c, d]).diagnostics).toEqual([]);
  expect(
    codes([
      main(),
      a,
      b
        .replace("EXTENDS IA", "")
        .replace("END_INTERFACE", "METHOD Run VAR_INPUT x: BOOL; END_VAR END_METHOD END_INTERFACE"),
      "INTERFACE ID EXTENDS IA, IB END_INTERFACE",
    ]),
  ).toContain("interface.signature");
});

it("rejects composite interface forwarding through the conservative call graph", () => {
  expect(
    codes([
      main(),
      actuator,
      `CLASS Group IMPLEMENTS IActuator
    VAR members: ARRAY[1..2] OF IActuator; END_VAR
    METHOD PUBLIC Start members[1].Start(); END_METHOD
    METHOD PUBLIC Value : INT END_METHOD END_CLASS`,
    ]),
  ).toContain("pou.recursion");
});

it("supports interfaces in structures, arrays, globals, parameters and results", () => {
  const result = compileProject(
    [
      main(
        "v: Valve; a: IActuator; h: Holder;",
        "a := Pass(v); h.link := a; h.links[1] := a; a.Start();",
      ),
      actuator,
      valve,
      "FUNCTION Pass : IActuator VAR_INPUT value: IActuator; END_VAR VAR_TEMP temporary: IActuator; END_VAR temporary := value; Pass := temporary; END_FUNCTION",
    ],
    ["TYPE Holder : STRUCT link: IActuator; links: ARRAY[1..2] OF IActuator; END_STRUCT; END_TYPE"],
  );
  expect(result.diagnostics).toEqual([]);
});

it.each(["INTERFACE", "END_INTERFACE", "IMPLEMENTS"])("reserves %s", (word) => {
  expect(codes([main(`${word}: INT;`)])).toContain(
    word === "END_INTERFACE" ? "syntax.missing-end" : "syntax.reserved-identifier",
  );
});

it.each([
  "a := REF(v);",
  "a ?= v;",
  "a := (a ?= b);",
  "n := a + 1;",
  "n := -a;",
  "n := ABS(a);",
  "n := arr[a];",
  "CASE a OF 1: END_CASE;",
  "FOR a := 1 TO 2 DO END_FOR;",
  "a := NULL; a := NULL + 1;",
  "n := a.0;",
])("reports codes without crashing for invalid interface expressions: %s", (body) => {
  expect(
    codes([
      main("a,b: IActuator; v: Valve; n: INT; arr: ARRAY[1..2] OF INT;", body),
      actuator,
      valve,
    ]).length,
  ).toBeGreaterThan(0);
});

it("rejects references to interface types", () => {
  expect(codes([main("r: REF_TO IActuator;"), actuator])).toContain(
    "type.invalid-reference-target",
  );
});

it("rejects interface assignments from a temporary instance alias", () => {
  const compiled = compileProject([
    main(),
    actuator,
    valve,
    "FUNCTION_BLOCK Container VAR_IN_OUT borrowed: Valve; END_VAR VAR a: IActuator; END_VAR a := borrowed; END_FUNCTION_BLOCK",
  ]);
  expect(compiled.diagnostics.map((d) => d.code)).toContain("interface.lifetime");
});

it.each([
  "INTERFACE I METHOD Run VAR_INPUT value: Missing; END_VAR END_METHOD END_INTERFACE",
  "INTERFACE I METHOD Run : Missing END_METHOD END_INTERFACE",
  "INTERFACE I METHOD Run VAR_INPUT value AT %MW0: INT; END_VAR END_METHOD END_INTERFACE",
  "INTERFACE I METHOD Run END_METHOD METHOD Run END_METHOD END_INTERFACE",
])("reports invalid prototypes without an implementation: %s", (source) => {
  expect(codes([main(), source]).length).toBeGreaterThan(0);
});

it("requires a variable source for assignment attempts", () => {
  expect(
    codes([
      main("a: IActuator;", "a ?= Get();"),
      actuator,
      "FUNCTION Get : IActuator END_FUNCTION",
    ]),
  ).toContain("interface.assignment-attempt");
});

it.each([
  "VAR_INPUT amount: INT; flag: BOOL; END_VAR VAR_OUTPUT seen: INT; END_VAR VAR_IN_OUT state: INT; END_VAR",
  "VAR_INPUT renamed: INT; flag: BOOL; END_VAR VAR_OUTPUT seen: INT; END_VAR VAR_IN_OUT state: INT; END_VAR",
  "VAR_INPUT amount: BOOL; flag: BOOL; END_VAR VAR_OUTPUT seen: INT; END_VAR VAR_IN_OUT state: INT; END_VAR",
  "VAR_INPUT flag: BOOL; amount: INT; END_VAR VAR_OUTPUT seen: INT; END_VAR VAR_IN_OUT state: INT; END_VAR",
  "VAR_INPUT amount: INT; flag: BOOL; END_VAR VAR_IN_OUT seen: INT; state: INT; END_VAR",
])(
  "requires identical implementation parameter names, types, order and sections: %s",
  (parameters) => {
    const prototype =
      "VAR_INPUT amount: INT; flag: BOOL; END_VAR VAR_OUTPUT seen: INT; END_VAR VAR_IN_OUT state: INT; END_VAR";
    const compiled = compileProject([
      main(),
      `INTERFACE I METHOD Run ${prototype} END_METHOD END_INTERFACE`,
      `CLASS Device IMPLEMENTS I METHOD PUBLIC Run ${parameters} END_METHOD END_CLASS`,
    ]);
    if (parameters === prototype) expect(compiled.diagnostics).toEqual([]);
    else {
      expect(compiled.ir).toBeUndefined();
      expect(compiled.diagnostics.map((d) => d.code)).toContain("interface.unimplemented");
    }
  },
);

const inOutProgram = "PROGRAM Main VAR_IN_OUT a: IActuator; END_VAR a.Start(); END_PROGRAM";
const inOutConfiguration = (connection = "") => `CONFIGURATION Config
VAR_GLOBAL shared: IActuator; extending: IExtended; device: Valve; number: INT; links: ARRAY[1..2] OF IActuator; END_VAR
RESOURCE Res ON BENCHTOP TASK Cycle(INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM mainInstance WITH Cycle: Main ${connection}; END_RESOURCE END_CONFIGURATION`;
const inOutSources = [
  inOutProgram,
  actuator,
  valve,
  "INTERFACE IExtended EXTENDS IActuator END_INTERFACE",
];

it("binds a PROGRAM interface in-out to an exact-type global interface cell", () => {
  const result = compileProject(inOutSources, [], inOutConfiguration("(a := shared)"));
  expect(result.diagnostics).toEqual([]);
  const shared = result.ir!.variables.findIndex((v) => v.key === "SHARED");
  expect(result.ir!.resource.programs[0]!.storage[0]).toEqual({
    kind: "variable",
    variable: shared,
  });
  expect(result.ir!.resource.programs[0]!.inputs).toBeUndefined();
});

it.each([
  ["", "call.missing-in-out"],
  ["(a := NULL)", "config.connection-target"],
  ["(a := device)", "config.connection-target"],
  ["(a := extending)", "call.in-out-type"],
  ["(a := number)", "call.in-out-type"],
  ["(a := %MW0)", "config.connection-target"],
  ["(a => shared)", "config.connection-direction"],
  ["(a := shared, a := shared)", "config.connection-duplicate"],
])("rejects invalid PROGRAM interface in-out bindings: %s", (connection, code) => {
  const result = compileProject(inOutSources, [], inOutConfiguration(connection));
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code, sourceKind: "configuration", sourceIndex: 0 }),
  );
});

it("requires an explicit configuration to bind PROGRAM interface in-outs", () => {
  expect(codes(inOutSources)).toContain("call.missing-in-out");
});

it("binds PROGRAM arrays of interfaces with exact array types", () => {
  const result = compileProject(
    [
      inOutProgram
        .replace("a: IActuator", "a: ARRAY[1..2] OF IActuator")
        .replace("a.Start()", "a[1].Start()"),
      actuator,
    ],
    [],
    inOutConfiguration("(a := links)")
      .replace("device: Valve;", "")
      .replace("extending: IExtended;", ""),
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.ir!.resource.programs[0]!.storage[0]!.kind).toBe("array");
});

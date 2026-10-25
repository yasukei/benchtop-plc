import { describe, expect, it } from "vitest";
import { compileProject } from "./index.js";

const point = "TYPE Point : STRUCT x : REAL; END_STRUCT; END_TYPE";
const program = (declarations: string, body = "") =>
  `PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`;
const compile = (declarations: string, body = "", types = [point]) =>
  compileProject([program(declarations, body)], types);

describe("references", () => {
  it("lowers REF_TO, NULL, REF and alternating dereference chains as plain data", () => {
    const result = compile(
      "p : Point; r : REF_TO Point := NULL; a : ARRAY[1..2] OF REF_TO Point; rr : REF_TO REF_TO Point;",
      "r := REF(p); a[1] := r; rr := REF(r); rr^^.x := a[1]^.x;",
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.variables.find((v) => v.key === "MAININSTANCE.R")).toMatchObject({
      kind: "reference",
      initialValue: null,
      dataType: { kind: "reference", target: { kind: "named", name: "Point" } },
    });
    expect(result.ir?.programs[0]!.body[0]).toMatchObject({ value: { kind: "referenceOf" } });
    expect(JSON.parse(JSON.stringify(result.ir))).toEqual(result.ir);
  });

  it("accepts persistent PROGRAM variables and function block inputs, outputs and locals", () => {
    const result = compileProject([
      program("b : Block; r : REF_TO INT;", "b(); r := REF(b.n); r := REF(b.q);"),
      "FUNCTION_BLOCK Block VAR_INPUT n : INT; END_VAR VAR_OUTPUT q : INT; END_VAR VAR x : INT; r : REF_TO INT; END_VAR r := REF(n); r := REF(q); r := REF(x); END_FUNCTION_BLOCK",
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("accepts references to subranges only when base and bounds match exactly", () => {
    expect(
      compile("x : INT (0..10); r : REF_TO Limits;", "r := REF(x);", [
        "TYPE Limits : INT (0..10); END_TYPE",
      ]).diagnostics,
    ).toEqual([]);
    for (const type of ["INT", "INT (1..10)", "UINT (0..10)"]) {
      const result = compile(`x : ${type}; r : REF_TO INT (0..10);`, "r := REF(x);");
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "type.assign-mismatch" }),
      );
    }
  });

  it.each([
    ["x : INT; r : REF_TO INT := REF(x);", "", "type.reference-initializer"],
    ["r : REF_TO INT := 0;", "", "type.reference-initializer"],
    ["r : REF_TO INT;", "r := REF(1 + 2);", "type.invalid-reference-target"],
    ["r : REF_TO INT;", "r := REF();", "type.invalid-reference-target"],
    ["r : REF_TO INT;", "r := REF(NULL);", "type.invalid-reference-target"],
    ["x : INT; r : REF_TO INT;", "r := REF(x + 1);", "type.invalid-reference-target"],
    ["x : WORD; r : REF_TO BOOL;", "r := REF(x.1);", "type.invalid-reference-target"],
    ["r : REF_TO INT;", "r := NULL; r := REF(r^);", "type.invalid-reference-target"],
    ["x : INT;", "x^ := 2;", "type.invalid-reference-target"],
    ["r : REF_TO INT; x : INT;", "r := x;", "type.assign-mismatch"],
    ["r : REF_TO INT; x : INT;", "x := r;", "type.assign-mismatch"],
    ["x : INT;", "x := NULL;", "type.invalid-reference-target"],
    ["r : REF_TO INT; b : BOOL;", "b := r < NULL;", "type.invalid-reference-target"],
    ["r : REF_TO INT; b : BOOL;", "b := r = 1;", "type.operand-mismatch"],
    ["r : REF_TO INT; b : BOOL;", "b := -r = NULL;", "type.operand-mismatch"],
    ["r : REF_TO INT; s : REF_TO REAL; b : BOOL;", "b := r = s;", "type.operand-mismatch"],
  ])("rejects invalid reference use: %s %s", (declarations, body, code) => {
    const result = compile(declarations, body);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
  });

  it.each([
    "PROGRAM Main VAR r : REF_TO INT; END_VAR VAR_TEMP x : INT; END_VAR r := REF(x); END_PROGRAM",
    "FUNCTION F : INT VAR x : INT; r : REF_TO INT; END_VAR r := REF(x); END_FUNCTION",
    "FUNCTION F : INT VAR_INPUT x : INT; END_VAR VAR r : REF_TO INT; END_VAR r := REF(x); END_FUNCTION",
    "FUNCTION_BLOCK B VAR_IN_OUT x : INT; END_VAR VAR r : REF_TO INT; END_VAR r := REF(x); END_FUNCTION_BLOCK",
    "PROGRAM Main VAR CONSTANT x : INT := 1; END_VAR VAR r : REF_TO INT; END_VAR r := REF(x); END_PROGRAM",
  ])("rejects targets without persistent mutable storage", (source) => {
    const result = compileProject(source.startsWith("PROGRAM") ? [source] : [program(""), source]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "type.invalid-reference-target" }),
    );
  });

  it.each(["REF_TO", "REF", "NULL"])("reserves %s", (name) => {
    expect(compile(`${name} : INT;`).diagnostics).toContainEqual(
      expect.objectContaining({ code: "syntax.reserved-identifier" }),
    );
  });
});

it("rejects reference use in integer control and index contexts", () => {
  for (const body of [
    "x := a[r];",
    "FOR r := 1 TO 2 DO END_FOR;",
    "CASE r OF 1: x := 1; END_CASE;",
    "x := ABS(r);",
  ]) {
    const result = compile("r : REF_TO INT; x : INT; a : ARRAY[1..2] OF INT;", body);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
  }
});

it("checks reference initializers inside arrays, structures and aliases", () => {
  for (const source of [
    "TYPE R : REF_TO INT := 1; END_TYPE",
    "TYPE Holder : STRUCT link : REF_TO INT := 1; END_STRUCT; END_TYPE",
    "TYPE Refs : ARRAY[1..2] OF REF_TO INT := [1]; END_TYPE",
  ]) {
    expect(compileProject([program("")], [source]).diagnostics).toContainEqual(
      expect.objectContaining({ code: "type.reference-initializer" }),
    );
  }
});

it("accepts reference aliases and mutually referenced structures", () => {
  const result = compile(
    "first : A; second : B; r : Link;",
    "r := REF(first); first.link := REF(second); second.link := r;",
    [
      "TYPE Link : REF_TO A; END_TYPE",
      "TYPE A : STRUCT link : REF_TO B; END_STRUCT; END_TYPE",
      "TYPE B : STRUCT link : Link; END_STRUCT; END_TYPE",
    ],
  );
  expect(result.diagnostics).toEqual([]);
});

it("allows indirection through named recursive arrays and reference aliases", () => {
  const cases = [
    [
      "TYPE Node : STRUCT children : REF_TO Nodes; END_STRUCT; END_TYPE",
      "TYPE Nodes : ARRAY[1..2] OF Node; END_TYPE",
    ],
    ["TYPE Links : ARRAY[1..2] OF REF_TO Links; END_TYPE"],
    ["TYPE Link : REF_TO Link; END_TYPE"],
    [
      "TYPE Node : STRUCT next : REF_TO NodeAlias; END_STRUCT; END_TYPE",
      "TYPE NodeAlias : Node; END_TYPE",
    ],
  ];
  for (const types of cases) {
    const name = types.length > 1 ? "Node" : types[0]!.includes("TYPE Links") ? "Links" : "Link";
    for (const ordered of [types, types.toReversed()]) {
      const result = compile(
        "first,second : " + name + "; r : REF_TO " + name + ";",
        "r := REF(first); r := REF(second);",
        ordered,
      );
      expect(result.diagnostics).toEqual([]);
    }
  }
});

it("rejects a subrange applied to a reference alias", () => {
  const result = compile("r : Link (0..10);", "", ["TYPE Link : REF_TO INT; END_TYPE"]);
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "type.invalid-constant" }),
  );
});

it("reports by-value cycles without publishing cyclic storage descriptors", () => {
  const cases = [
    ["TYPE A : ARRAY[1..2] OF A; END_TYPE", "TYPE B : STRUCT a : A; END_STRUCT; END_TYPE"],
    [
      "TYPE A : STRUCT b : B; END_STRUCT; END_TYPE",
      "TYPE B : STRUCT a : A; END_STRUCT; END_TYPE",
      "TYPE C : STRUCT a : A; END_STRUCT; END_TYPE",
    ],
    [
      "TYPE A : ARRAY[1..2] OF B; END_TYPE",
      "TYPE B : ARRAY[1..2] OF A; END_TYPE",
      "TYPE C : STRUCT a : A; END_STRUCT; END_TYPE",
    ],
  ];
  for (const types of cases) {
    for (const ordered of [types, types.toReversed()]) {
      const result = compileProject([program("")], ordered);
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "decl.type-cycle" }),
      );
    }
  }
});

it.each(["r := SEL(TRUE, REF(x), REF(y));", "r := MUX(0, REF(x), REF(y));", "r := MOVE(REF(y));"])(
  "rejects selection between distinct reference targets: %s",
  (body) => {
    const result = compile("x : INT (0..10); y : INT; r : REF_TO INT (0..10);", body);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: body.includes("MOVE") ? "type.assign-mismatch" : "call.argument-type",
      }),
    );
  },
);

it.each(["r := SEL(r, r, r);", "r := MUX(r, r, r);", "r := ADD(r, r);"])(
  "rejects reference selectors and arithmetic: %s",
  (body) => {
    expect(compile("r : REF_TO INT;", body).ir).toBeUndefined();
  },
);

it("rejects mismatched dereferenced in-outs and bit actuals", () => {
  for (const [declarations, actual, code] of [
    ["r : REF_TO INT (0..10);", "r^", "call.in-out-type"],
    ["r : REF_TO WORD;", "r^.1", "call.in-out-variable"],
  ]) {
    const result = compileProject([
      program(declarations!, `Inc(v := ${actual});`),
      "FUNCTION Inc VAR_IN_OUT v : INT; END_VAR v := v + 1; END_FUNCTION",
    ]);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
  }
});

it.each([
  "REF_TO MissingType",
  "REF_TO REF_TO MissingType",
  "REF_TO ARRAY[1..2] OF MissingType",
  "ARRAY[1..2] OF REF_TO MissingType",
])("reports the unknown reference target once: %s", (type) => {
  const source = `TYPE BadR : ${type}; END_TYPE`;
  const result = compileProject([program("")], [source]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code: "decl.unknown-type",
      args: { name: "MissingType" },
      span: expect.objectContaining({
        column: source.indexOf("MissingType") + 1,
        endColumn: source.indexOf("MissingType") + 12,
      }),
    }),
  ]);
});

it("reports a standard block reference target as unsupported", () => {
  const target = "TON";
  const result = compileProject(
    [program(""), "FUNCTION_BLOCK Block END_FUNCTION_BLOCK"],
    [`TYPE BadR : REF_TO ${target}; END_TYPE`],
  );
  expect(result.diagnostics).toEqual([
    expect.objectContaining({ code: "type.invalid-reference-target", args: {} }),
  ]);
});

it("reports failed reference variable and result types without synthetic unknown types", () => {
  for (const source of [
    program("r : REF_TO MissingType;"),
    "FUNCTION F : REF_TO MissingType END_FUNCTION",
  ]) {
    const result = compileProject(source.startsWith("PROGRAM") ? [source] : [program(""), source]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "decl.unknown-type", args: { name: "MissingType" } }),
    ]);
  }
});

it.each([
  "x := NULL;",
  "x := -NULL;",
  "b := NULL < r;",
  "x := MOVE(NULL);",
  "r := SEL(TRUE, NULL, 1);",
  "x := a[NULL];",
])("rejects invalid NULL contexts without inventing a BOOL target: %s", (body) => {
  const result = compile("x : INT; b : BOOL; r : REF_TO INT; a : ARRAY[1..2] OF INT;", body);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code: "type.invalid-reference-target", args: {} }),
  );
  expect(JSON.stringify(result.diagnostics)).not.toContain('"target":"BOOL"');
});

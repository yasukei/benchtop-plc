import { describe, expect, it } from "vitest";
import { compile, compileProject, parse } from "./index.js";
import { check } from "./checker.js";

const source = (declarations: string, body = "") =>
  `PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`;
function valid(declarations: string, body = "") {
  const result = compile(source(declarations, body));
  expect(result.diagnostics).toEqual([]);
  expect(result.ir).toBeDefined();
  return result.ir!;
}
function variants(declarations: string, body: string) {
  return valid(declarations, body).variables.flatMap((variable) =>
    variable.kind === "functionBlock" ? [variable.fbType] : [],
  );
}

describe("overloaded standard function blocks", () => {
  it.each(["TON", "TOF", "TP"])("selects %s_LTIME from calls and assignments", (name) => {
    for (const body of ["t(PT := short); t.PT := longTime;", "t.PT := longTime; t(PT := short);"]) {
      const ir = valid(
        `t: ${name}; short: TIME; longTime: LTIME; elapsed: LTIME;`,
        `${body} elapsed := t.ET; t(ET => elapsed);`,
      );
      expect(ir.variables[0]).toMatchObject({ fbType: `${name}_LTIME` });
      expect(ir.body[0]).toMatchObject(
        body.startsWith("t(")
          ? { inputs: [{ value: { kind: "functionCall", function: "TIME_TO_LTIME" } }] }
          : { value: { dataType: "LTIME" } },
      );
    }
  });

  it.each(["CTU", "CTD", "CTUD"])("selects every %s counter variant", (name) => {
    for (const [type, variant] of [
      ["SINT", name],
      ["INT", name],
      ["USINT", name],
      ["UINT", `${name}_DINT`],
      ["DINT", `${name}_DINT`],
      ["UDINT", `${name}_UDINT`],
      ["LINT", `${name}_LINT`],
      ["ULINT", `${name}_ULINT`],
    ])
      expect(variants(`c: ${name}; preset: ${type};`, "c(PV := preset);")).toEqual([variant]);
  });

  it("takes a common type across all bindings before choosing a variant", () => {
    expect(
      variants("c: CTU; signed: INT; unsigned: UDINT;", "c(PV := signed); c.PV := unsigned;"),
    ).toEqual(["CTU_LINT"]);
    expect(variants("a, b: CTU;", "a(PV := DINT#40000); b(PV := ULINT#1);")).toEqual([
      "CTU_DINT",
      "CTU_ULINT",
    ]);
  });

  it.each(["BYTE#1", "REAL#1.0", "TRUE"])(
    "rejects selecting types without a matching variant: %s",
    (binding) => {
      const result = compile(source("c: CTU;", `c(PV := ${binding});`));
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "fb.no-matching-variant",
      ]);
    },
  );

  it("rejects LINT with ULINT in either order", () => {
    for (const body of ["c(PV := LINT#1); c.PV := ULINT#1;", "c.PV := ULINT#1; c(PV := LINT#1);"]) {
      const result = compile(source("c: CTU;", body));
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "fb.no-matching-variant",
      ]);
    }
  });

  it("rejects incompatible timer selecting types", () => {
    const result = compile(source("t: TON;", "t(PT := T#1s); t.PT := DINT#1000;"));
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "fb.no-matching-variant",
    ]);
  });

  it.each([
    ["c(PV := a); c.PV := b; c(PV := 100000); c.PV := 100000;", ["fb.no-matching-variant"]],
    ["c(PV := d.Q);", ["fb.no-matching-variant"]],
    ["c(PV := BYTE#1); c.PV := missing;", ["fb.no-matching-variant", "name.undeclared"]],
    ["c(PV := BYTE#1, CU := INT#1);", ["fb.no-matching-variant", "type.assign-mismatch"]],
    ["c(PV := BYTE#1, PV := BYTE#2);", ["fb.no-matching-variant", "fb.duplicate-input"]],
    ["c(PV := BYTE#1); c.PV := INT#40000;", ["fb.no-matching-variant", "type.invalid-constant"]],
  ] as const)(
    "avoids default preset errors after failed selection while checking expressions: %s",
    (body, codes) => {
      const result = compile(source("c: CTU; a: LINT; b: ULINT; d: TON;", body));
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(codes);
    },
  );

  it.each(["100000", "(50000 + 50000)"])(
    "leaves %s untyped until checking against INT",
    (value) => {
      const result = compile(source("c: CTU;", `c(PV := ${value});`));
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
        "type.invalid-constant",
      ]);
      expect(variants("c: CTU;", `c(PV := ${value}); c(PV := DINT#1);`)).toEqual(["CTU_DINT"]);
    },
  );

  it("uses constants, expressions, fixed-result functions and explicitly typed ports", () => {
    const result = compile(`PROGRAM Main
      VAR CONSTANT preset: DINT := 40000; END_VAR
      VAR a, b, c, d: CTU; fixed: CTU_ULINT; END_VAR
      a(PV := preset + 1); b(PV := MAX(DINT#1, 2));
      c(PV := TO_DINT(100000)); d(PV := fixed.CV);
      END_PROGRAM`);
    expect(result.diagnostics).toEqual([]);
    expect(
      result.ir!.variables.slice(0, 4).map((v) => v.kind === "functionBlock" && v.fbType),
    ).toEqual(["CTU_DINT", "CTU_DINT", "CTU_DINT", "CTU_ULINT"]);
  });

  it.each([false, true])("does not infer through cyclic dependencies (reversed: %s)", (reverse) => {
    const calls = ["a(PV := b.CV);", "b(PV := a.CV);"];
    expect(
      variants(
        reverse ? "b, a: CTU;" : "a, b: CTU;",
        (reverse ? calls.reverse() : calls).join(" "),
      ),
    ).toEqual(["CTU", "CTU"]);
  });

  it.each([false, true])("checks dependent bindings after selection (reversed: %s)", (reverse) => {
    const calls = ["a(PV := b.CV);", "b(PV := DINT#100);"];
    const result = compile(
      source(reverse ? "b, a: CTU;" : "a, b: CTU;", (reverse ? calls.reverse() : calls).join(" ")),
    );
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toMatchObject([
      { code: "type.assign-mismatch", args: { from: "DINT", to: "INT" } },
    ]);
  });

  it.each(["a(PV := b.CV); b(PV := a.CV);", "b(PV := a.CV); a(PV := b.CV);"])(
    "keeps cyclic variants with fixed declaration order: %s",
    (body) => {
      expect(variants("a, b: CTU;", body)).toEqual(["CTU", "CTU"]);
    },
  );

  it.each(["a(PV := b.CV); b(PV := DINT#100);", "b(PV := DINT#100); a(PV := b.CV);"])(
    "checks dependent bindings with fixed declaration order: %s",
    (body) => {
      const result = compile(source("a, b: CTU;", body));
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics).toMatchObject([
        { code: "type.assign-mismatch", args: { from: "DINT", to: "INT" } },
      ]);
    },
  );

  it.each(["b.CV", "b.PV", "(b.CV + DINT#1)", "TO_DINT(b.PV)", "MAX(b.CV, DINT#1)"])(
    "excludes the entire expression reading an inferred member: %s",
    (value) => {
      const result = compile(source("a, b: CTU;", `a(PV := ${value}); b(PV := DINT#100);`));
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "type.assign-mismatch",
          args: { from: "DINT", to: "INT", hint: "explicit-conversion" },
        }),
      );
    },
  );

  it("excludes self references and inferred timer ports, but not fixed BOOL ports", () => {
    expect(variants("c: CTU;", "c(PV := c.PV); c.PV := c.PV + 10;")).toEqual(["CTU"]);
    expect(
      compile(source("a, b: TON;", "a(PT := b.ET + T#1s); b(PT := LT#1ns);")).diagnostics,
    ).toMatchObject([{ code: "type.assign-mismatch", args: { from: "LTIME", to: "TIME" } }]);
    expect(variants("a: CTU; b: TON;", "a(PV := BOOL_TO_DINT(b.Q));")).toEqual(["CTU_DINT", "TON"]);
  });

  it("never selects from outputs or changes explicitly typed names", () => {
    expect(variants("c: CTU; n: DINT;", "c(CV => n); n := c.CV;")).toEqual(["CTU"]);
    expect(variants("c: CTU_DINT;", "c(PV := 100000);")).toEqual(["CTU_DINT"]);
    const result = compile(source("c: CTU_INT;", "c(PV := DINT#100);"));
    expect(result.diagnostics).toMatchObject([{ code: "type.assign-mismatch" }]);
    expect(
      compile(source("c: CTU; n: INT;", "c(PV := DINT#1, CV => n);")).diagnostics,
    ).toMatchObject([{ code: "type.assign-mismatch", args: { from: "DINT", to: "INT" } }]);
  });

  it.each([
    "IF FALSE THEN c(PV := DINT#1); END_IF;",
    "IF FALSE THEN ELSE c.PV := DINT#1; END_IF;",
    "CASE 1 OF 0: c(PV := DINT#1); END_CASE;",
    "CASE 1 OF 0: ELSE c.PV := DINT#1; END_CASE;",
    "FOR i := 1 TO 0 DO c(PV := DINT#1); END_FOR;",
    "WHILE FALSE DO c.PV := DINT#1; END_WHILE;",
    "REPEAT c(PV := DINT#1); UNTIL TRUE END_REPEAT;",
  ])("finds bindings in nested control flow: %s", (body) => {
    expect(variants("c: CTU; i: INT;", body)).toEqual(["CTU_DINT"]);
  });

  it("selects per declaration in user blocks without caller inference", () => {
    const result = compileProject([
      "PROGRAM Main VAR a, b: Block; END_VAR a(preset := 40000); b(preset := 50000); END_PROGRAM",
      "FUNCTION_BLOCK Block VAR_INPUT preset: DINT; END_VAR VAR c: CTU; END_VAR c(PV := preset); END_FUNCTION_BLOCK",
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir!.variables).toMatchObject([
      { name: "A.PRESET" },
      { name: "A.C", fbType: "CTU_DINT" },
      { name: "B.PRESET" },
      { name: "B.C", fbType: "CTU_DINT" },
    ]);
  });

  it("keeps the declared AST and legacy default IR unchanged", () => {
    const ast = parse(source("t: TON; c: CTU;", "t(PT := LT#1ns); c(PV := DINT#1);")).ast!;
    const before: unknown = JSON.parse(JSON.stringify(ast));
    expect(check(ast).diagnostics).toEqual([]);
    expect(ast).toEqual(before);
    expect(variants("t: TON; c: CTU;", "t(PT := T#1s); c(PV := 1);")).toEqual(["TON", "CTU"]);
  });
});

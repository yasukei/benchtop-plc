import { describe, expect, it } from "vitest";
import { check, compile, compileProject, parse } from "./index.js";

const program = (declarations: string, body = "") =>
  `PROGRAM Main ${declarations} ${body} END_PROGRAM`;

describe("named constants", () => {
  it("folds earlier constants with their declared types and allocates no symbol or IR variable", () => {
    const source = program(
      `VAR CONSTANT N : INT := 30000; Wrapped : INT := n + N; END_VAR
       VAR a : INT := Wrapped; END_VAR
       VAR CONSTANT DefaultInt : INT; DefaultLong : LINT; DefaultBool : BOOL; END_VAR
       VAR b : LINT := DefaultLong; c : BOOL := DefaultBool; d : INT := DefaultInt; END_VAR`,
      "a := N + N;",
    );
    const ast = parse(source).ast!;
    const checked = check(ast);
    expect(checked.diagnostics).toEqual([]);
    expect(checked.checked!.symbols.map((symbol) => [symbol.id, symbol.name.name])).toEqual([
      [0, "a"],
      [1, "b"],
      [2, "c"],
      [3, "d"],
    ]);
    for (const declaration of ast.declarations.filter((item) => item.constant))
      expect(checked.checked!.references.has(declaration.names[0])).toBe(false);
    const compiled = compile(source);
    expect(compiled.diagnostics).toEqual([]);
    expect(
      compiled.ir!.variables.map((variable) => [
        variable.name.replace(/^mainInstance\./, ""),
        variable.initialValue,
      ]),
    ).toEqual([
      ["a", -5536],
      ["b", "0"],
      ["c", false],
      ["d", 0],
    ]);
    expect(compiled.ir!.programs[0]!.body[0]).toMatchObject({
      kind: "assignment",
      target: { variable: 0 },
      value: { kind: "literal", dataType: "INT", value: -5536 },
    });
  });

  it("uses constants in CASE ranges, bit indices, FOR bounds/step and conversions", () => {
    const compiled = compile(
      program(
        `VAR CONSTANT First : INT := 1; Last : INT := 3; Step : INT := 2;
       BitIndex : INT := 7; END_VAR VAR x, i : INT; bits : BYTE; END_VAR`,
        `CASE x OF First..Last: x := First; END_CASE;
       bits.BitIndex := TRUE;
       FOR i := First TO Last BY Step DO x := x + i; END_FOR;`,
      ),
    );
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.ir!.programs[0]!.body[0]).toMatchObject({
      kind: "case",
      branches: [{ labels: [{ kind: "range", lower: 1, upper: 3 }] }],
    });
    expect(compiled.ir!.programs[0]!.body[1]).toMatchObject({
      kind: "assignment",
      target: { kind: "bit", variable: 2, bit: 7 },
    });
    expect(compiled.ir!.programs[0]!.body[2]).toMatchObject({
      kind: "for",
      variable: { variable: 1 },
      from: { value: 1 },
      to: { value: 3 },
      step: { value: 2 },
    });
    expect(
      compile(program("VAR CONSTANT N : INT := 3; END_VAR VAR x : DINT := INT_TO_DINT(N); END_VAR"))
        .ir!.variables[0],
    ).toMatchObject({ initialValue: 3 });
  });

  it("folds bit reads from constants and rejects writing their bits", () => {
    const declarations =
      "VAR CONSTANT Mask : LWORD := LWORD#16#8000000000000000; Index : INT := 63; END_VAR VAR flag : BOOL := Mask.Index; END_VAR";
    expect(compile(program(declarations, "flag := Mask.Index;")).ir).toMatchObject({
      variables: [{ name: "mainInstance.flag", initialValue: true }],
      programs: [{ body: [{ kind: "assignment", value: { kind: "literal", value: true } }] }],
    });
    expect(compile(program(declarations, "Mask.Index := FALSE;")).diagnostics).toContainEqual(
      expect.objectContaining({ code: "decl.constant-not-writable" }),
    );
  });

  it.each([
    ["40000", "type.invalid-constant"],
    ["TRUE", "type.assign-mismatch"],
  ])("reports only the root error for a failed initializer %s", (initializer, code) => {
    const result = compile(
      program(
        `VAR CONSTANT N : INT := ${initializer}; Derived : INT := N; END_VAR
         VAR x : INT := Derived; bits : BYTE; flag : BOOL; END_VAR`,
        "x := N; bits.N := TRUE; flag := N.0;",
      ),
    );
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([code]);
  });

  it.each([
    ["VAR CONSTANT A : INT := A; END_VAR", "decl.constant-order"],
    ["VAR CONSTANT A : INT := B; B : INT := 2; END_VAR", "decl.constant-order"],
    ["VAR CONSTANT A : INT := B; B : INT := A; END_VAR", "decl.constant-order"],
    [
      "VAR CONSTANT Mask : BYTE := 1; Flag : BOOL := Mask.Index; Index : INT := 0; END_VAR",
      "decl.constant-order",
    ],
    ["VAR a : INT := N; END_VAR VAR CONSTANT N : INT := 2; END_VAR", "decl.constant-order"],
    ["VAR x : INT; END_VAR VAR CONSTANT N : INT := x; END_VAR", "decl.nonconstant-initializer"],
    ["VAR CONSTANT N : INT := 40000; END_VAR", "type.invalid-constant"],
    ["VAR CONSTANT N : INT := 30000 + 30000; END_VAR", "type.invalid-constant"],
    ["VAR CONSTANT N : INT := 1 / 0; END_VAR", "type.invalid-constant"],
    ["VAR CONSTANT N AT %IX0.0 : BOOL; END_VAR", "decl.constant-address"],
    ["VAR CONSTANT timer : TON; END_VAR", "decl.constant-type"],
    ["VAR CONSTANT N : INT; END_VAR VAR n : INT; END_VAR", "decl.duplicate"],
    ["VAR N : INT; END_VAR VAR CONSTANT n : INT; END_VAR", "decl.duplicate"],
    ["VAR CONSTANT ABS : INT; END_VAR", "decl.name-collision"],
  ])("rejects %s with %s", (declarations, code) => {
    const result = compile(program(declarations));
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code, pou: "Main", span: expect.any(Object) }),
    );
  });

  it.each(["VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT", "VAR_TEMP"])(
    "rejects CONSTANT on %s, even empty",
    (section) => {
      for (const declarations of ["", "N : INT;"])
        expect(
          compileProject([
            program(""),
            `FUNCTION_BLOCK Block ${section} CONSTANT ${declarations} END_VAR END_FUNCTION_BLOCK`,
          ]).diagnostics,
        ).toContainEqual(
          expect.objectContaining({ code: "decl.constant-section", args: { section } }),
        );
    },
  );

  it.each(["N := 5;", "FOR N := 1 TO 2 DO END_FOR;", "F(Q => N);", "F(A := N);"])(
    "rejects a constant write through %s",
    (body) => {
      const result = compileProject([
        program("VAR CONSTANT N : INT := 10; END_VAR", body),
        "FUNCTION F VAR_OUTPUT Q : INT; END_VAR VAR_IN_OUT A : INT; END_VAR END_FUNCTION",
      ]);
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics).toContainEqual(
        expect.objectContaining({ code: "decl.constant-not-writable" }),
      );
    },
  );

  it.each(["-1", "8", "2147483647"])("rejects out-of-range constant bit index %s", (value) => {
    const result = compile(
      program(
        `VAR CONSTANT N : DINT := ${value}; END_VAR VAR bits : BYTE; END_VAR`,
        "bits.N := TRUE;",
      ),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "type.invalid-bit-access" }),
    );
  });

  it("keeps constants local to their POU", () => {
    const result = compileProject([
      program("VAR CONSTANT N : INT := 2; END_VAR"),
      "FUNCTION F : INT F := N; END_FUNCTION",
    ]);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "name.undeclared", pou: "F" }),
    );
  });

  it("rejects user function block instances as constants", () => {
    expect(
      compileProject([
        program("VAR CONSTANT inst : Block; END_VAR"),
        "FUNCTION_BLOCK Block END_FUNCTION_BLOCK",
      ]).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: "decl.constant-type" }));
  });
});

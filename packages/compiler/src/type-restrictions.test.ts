import { describe, expect, it } from "vitest";
import type { TypeDescriptor } from "@benchtop-plc/core";
import { compileProject } from "./index.js";

const program = (declarations = "", body = "") =>
  `PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`;

describe("function block structure members", () => {
  it.each(["TON", "ton", "CTU_LINT", "CustomBlock", "customBlock"])(
    "names %s through every array layer and spans the member type",
    (name) => {
      for (const type of [
        name,
        `ARRAY[1..2] OF ${name}`,
        `ARRAY[1..2] OF ARRAY[1..3] OF ${name}`,
      ]) {
        const result = compileProject(
          [program(), "FUNCTION_BLOCK CustomBlock END_FUNCTION_BLOCK"],
          [`TYPE S : STRUCT\n  t : ${type};\nEND_STRUCT; END_TYPE`],
        );
        expect(result.ir).toBeUndefined();
        expect(result.diagnostics).toEqual([
          {
            code: "decl.structure-member-type",
            args: { name },
            severity: "error",
            pou: "S",
            sourceKind: "dataType",
            sourceIndex: 0,
            span: { line: 2, column: 7, endLine: 2, endColumn: 7 + type.length },
          },
        ]);
      }
    },
  );

  it("preserves the separate restriction for a named block array", () => {
    const result = compileProject([program()], ["TYPE S : ARRAY[1..2] OF TON; END_TYPE"]);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "decl.fb-array-form", args: { form: "named" } }),
    ]);
  });
});

describe("type cycle diagnostics", () => {
  it.each([
    ["TYPE Node : STRUCT next : Node; END_STRUCT; END_TYPE"],
    ["TYPE Node : STRUCT next : ARRAY[1..2] OF Node; END_STRUCT; END_TYPE"],
    ["TYPE A : STRUCT b : B; END_STRUCT; END_TYPE", "TYPE B : STRUCT a : A; END_STRUCT; END_TYPE"],
    ["TYPE A : B; END_TYPE", "TYPE B : A; END_TYPE"],
    ["TYPE A : STRUCT b : B; END_STRUCT; END_TYPE", "TYPE B : ARRAY[1..2] OF A; END_TYPE"],
    ["TYPE A : b; END_TYPE", "TYPE B : a; END_TYPE"],
    ["TYPE A : A; END_TYPE"],
  ])("identifies a cycle once without unknown-type or constant errors: %s", (...types) => {
    for (const ordered of [types, types.toReversed()]) {
      const name = ordered[0]!.split(" ")[1]!;
      const result = compileProject([program()], ordered);
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics).toEqual([
        {
          code: "decl.type-cycle",
          args: { name },
          severity: "error",
          pou: name,
          sourceKind: "dataType",
          sourceIndex: 0,
          span: { line: 1, column: 6, endLine: 1, endColumn: 6 + name.length },
        },
      ]);
    }
  });

  it("does not repeat a shared cycle or mistake dependent aliases for unknown types", () => {
    const result = compileProject(
      [program()],
      [
        "TYPE A : B; END_TYPE",
        "TYPE B : A; END_TYPE",
        "TYPE C : A; END_TYPE",
        "TYPE D : C; END_TYPE",
        "TYPE E : E; END_TYPE",
      ],
    );
    expect(result.diagnostics.map(({ code, args }) => ({ code, args }))).toEqual([
      { code: "decl.type-cycle", args: { name: "A" } },
      { code: "decl.type-cycle", args: { name: "E" } },
    ]);
  });

  it.each([
    "STRUCT x : A; END_STRUCT",
    "STRUCT x : ARRAY[1..2] OF A; END_STRUCT",
    "ARRAY[1..2] OF A",
    "ARRAY[1..2] OF ARRAY[1..3] OF A",
    "STRUCT x : REF_TO A; END_STRUCT",
    "REF_TO A",
    "ARRAY[1..2] OF REF_TO A",
  ])("does not cascade alias cycle errors through %s in any declaration order", (type) => {
    const cycle = ["TYPE A : B; END_TYPE", "TYPE B : A; END_TYPE"];
    const dependent = `TYPE C : ${type}; END_TYPE`;
    for (const types of [
      [dependent, ...cycle],
      [...cycle, dependent],
    ]) {
      const result = compileProject([program()], types);
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ code: "decl.type-cycle", args: { name: "A" } }),
      ]);
    }
  });

  it("still reports genuinely unknown alias targets", () => {
    expect(compileProject([program()], ["TYPE A : Missing; END_TYPE"]).diagnostics).toEqual([
      expect.objectContaining({ code: "decl.unknown-type", args: { name: "Missing" } }),
    ]);
  });

  it("allows recursive structures through references", () => {
    const result = compileProject(
      [program("nodeValue : Node;")],
      ["TYPE Node : STRUCT next : REF_TO Node; v : INT; END_STRUCT; END_TYPE"],
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.ir).toBeDefined();
  });
});

describe("FOR control variable restrictions", () => {
  it.each<[string, TypeDescriptor]>([
    ["Percent", { kind: "named", name: "Percent" }],
    ["INT (0..100)", { kind: "subrange", base: "INT", lower: 0, upper: 100 }],
    ["AliasPercent", { kind: "named", name: "AliasPercent" }],
  ])("explains the subrange restriction for %s", (type, descriptor) => {
    const result = compileProject(
      [program(`p : ${type};`, "FOR p := 0 TO 10 DO END_FOR;")],
      ["TYPE Percent : INT (0..100); END_TYPE", "TYPE AliasPercent : Percent; END_TYPE"],
    );
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "type.for-variable-subrange",
        args: { name: "p", type: descriptor },
      }),
    ]);
  });

  it.each<[string, TypeDescriptor]>([
    ["REAL", "REAL"],
    ["State", { kind: "named", name: "State" }],
  ])("retains the non-integer diagnostic for %s", (type, descriptor) => {
    const result = compileProject(
      [program(`p : ${type};`, "FOR p := 0 TO 10 DO END_FOR;")],
      ["TYPE State : (Idle, Running); END_TYPE"],
    );
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "type.for-variable-not-integer",
        args: { name: "p", type: descriptor },
      }),
    ]);
  });
});

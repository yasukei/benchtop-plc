import { describe, expect, it } from "vitest";
import type { GlobalScope } from "./checked.js";
import { check, checkDeclarations, discoverOverloadBindings } from "./checker.js";
import { parsePou } from "./parser.js";

function parse(source: string) {
  const result = parsePou(source);
  expect(result.diagnostics).toEqual([]);
  return result.ast!;
}

describe("checker phases", () => {
  it("resolves initializer-dependent signatures before checking function bodies", () => {
    const ast = parse(`FUNCTION Copy : ARRAY [1..size] OF INT
      VAR CONSTANT size : INT := 3; END_VAR
      VAR_INPUT values : ARRAY [1..size] OF INT; END_VAR
      missing := TRUE;
      END_FUNCTION`);
    const pous = new Map([[ast.name.key, ast]]);
    const declarations = checkDeclarations(ast, [], pous, new Map());
    expect(declarations.diagnostics).toEqual([]);
    expect(declarations.checked!.result!.descriptor).toEqual({
      kind: "array",
      dimensions: [{ lower: 1, upper: 3 }],
      element: "INT",
    });
    expect(declarations.checked!.symbols[0]!.descriptor).toEqual(
      declarations.checked!.result!.descriptor,
    );
    expect(declarations.checked!.result!.aggregateValues).toEqual([0, 0, 0]);
    expect(check(ast).diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "name.undeclared",
    ]);
    ast.body = [];
    expect(check(ast).diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "pou.result-not-assigned",
    ]);
  });

  it("returns shared overload bindings without mutating inputs or caching speculative types", () => {
    const globals = check(parse("PROGRAM Globals VAR counter : CTU; END_VAR END_PROGRAM")).checked!;
    const scope: GlobalScope = {
      symbols: globals.symbols,
      constants: globals.constants,
      bindings: new Map(),
      memberBindings: new Map(),
    };
    const ast = parse(`PROGRAM Main
      VAR_EXTERNAL counter : CTU; END_VAR
      VAR CONSTANT preset : DINT := 40000; END_VAR
      VAR observed : DINT; END_VAR
      counter(PV := preset);
      observed := counter.CV;
      END_PROGRAM`);
    const before: unknown = JSON.parse(JSON.stringify(ast));
    const pous = new Map([[ast.name.key, ast]]);
    const bindings = discoverOverloadBindings(
      ast,
      pous,
      new Map(),
      new Map(),
      [],
      new Map(),
      scope,
    );
    expect([...bindings.bindings]).toEqual([["COUNTER", ["DINT"]]]);
    expect(scope.bindings.size).toBe(0);
    expect(scope.memberBindings!.size).toBe(0);
    expect(globals.symbols[0]!.type).toBe("CTU");
    expect(ast).toEqual(before);

    const result = check(ast, pous, new Map(), new Map(), [], new Map(), {
      ...scope,
      ...bindings,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.checked!.symbols[0]!.type).toBe("CTU_DINT");
    const assignment = ast.body[1]!;
    if (assignment.kind !== "assignment") throw new Error("Expected assignment");
    expect(result.checked!.expressions.get(assignment.value)).toEqual({ dataType: "DINT" });
  });
});

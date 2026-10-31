import { describe, expect, it } from "vitest";
import { check, compile, compileProject, lex, lower, parse } from "./index.js";
import type { CompileResult, Program } from "./index.js";

const source = "PROGRAM Counter VAR count: INT; END_VAR count := count + 1; END_PROGRAM";

describe("@benchtop-plc/compiler public API", () => {
  it("connects lexing, parsing, checking and lowering to compilation", () => {
    expect(lex(source).diagnostics).toEqual([]);
    const parsed = parse(source);
    expect(parsed.diagnostics).toEqual([]);
    const ast: Program = parsed.ast!;
    const checked = check(ast);
    expect(checked.diagnostics).toEqual([]);
    const compiled: CompileResult = compile(source);
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.ir).toMatchObject({
      kind: "configuration",
      variables: [{ name: "mainInstance.count", dataType: "INT", initialValue: 0 }],
      programs: [{ name: "Counter", body: [{ kind: "assignment" }] }],
    });
    expect(
      lower([checked.checked!], {
        name: "Config",
        resource: "Res",
        explicit: false,
        span: ast.span,
        tasks: [{ name: "Cyclic", intervalMs: 10, priority: 1 }],
        programs: [{ name: "mainInstance", program: 0, task: 0 }],
      }),
    ).toEqual(compiled.ir);
    expect(compileProject([source])).toMatchObject({ ir: compiled.ir, diagnostics: [] });
  });

  it("returns diagnostics and no IR for an invalid program", () => {
    const result = compile("PROGRAM Invalid missing := TRUE; END_PROGRAM");
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "name.undeclared",
        severity: "error",
        args: { name: "missing" },
      }),
    );
  });
});

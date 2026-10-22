import { describe, expect, it } from "vitest";
import { compile, compileProject, parsePou } from "./index.js";

const main = (body = "", declarations = "x: INT;") =>
  `PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`;
const fn = (
  body = "F := A + B;",
  declarations = "VAR_INPUT A: INT := 10; B: INT; END_VAR",
  result = ": INT",
) => `FUNCTION F ${result} ${declarations} ${body} END_FUNCTION`;

function rejects(sources: string[], code: string, pou?: string) {
  const result = compileProject(sources);
  expect(result.ir).toBeUndefined();
  const diagnostic = result.diagnostics.find((item) => item.code === code);
  expect(diagnostic).toBeDefined();
  expect(diagnostic?.pou).toBe(pou);
  if (pou) expect(diagnostic?.span).toBeDefined();
  return diagnostic!;
}

describe("project-wide POU compilation", () => {
  it("preserves the single-program entry point and IR", () => {
    expect(compileProject([main()])).toEqual(compile(main()));
    expect(compileProject([main()]).ir).not.toHaveProperty("functions");
  });

  it("resolves forward calls case-insensitively and shares bodies", () => {
    const result = compileProject([main("x := f(1, 2) + F(B := 3);"), fn()]);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.functions).toHaveLength(1);
    expect(result.ir?.functions?.[0]?.inputs).toEqual([0, 1]);
    expect(result.ir?.body[0]).toMatchObject({
      value: {
        left: { kind: "userFunctionCall", function: 0 },
        right: { kind: "userFunctionCall", function: 0 },
      },
    });
    expect(JSON.parse(JSON.stringify(result.ir))).toEqual(result.ir);
  });

  it("reports a duplicate on the later POU", () => {
    const diagnostic = rejects(
      [main(), "FUNCTION foo END_FUNCTION", "FUNCTION FOO END_FUNCTION"],
      "pou.duplicate",
      "FOO",
    );
    expect(diagnostic.args).toEqual({ name: "FOO" });
    expect(diagnostic.span).toEqual({ line: 1, column: 10, endLine: 1, endColumn: 13 });
  });

  it.each([
    "ton",
    "TON_LTIME",
    "CTU_DINT",
    "ABS",
    "INT_TO_REAL",
    "TO_INT",
    "TRUNC_INT",
    "REAL_TRUNC_INT",
    "WORD_BCD_TO_INT",
    "INT_TO_BCD_WORD",
    "INT",
    "TIME_OF_DAY",
  ])("rejects a POU colliding with %s", (name) => {
    rejects([main(), `FUNCTION ${name} END_FUNCTION`], "pou.name-collision", name);
  });

  it.each([{ sources: [] }, { sources: [fn()] }])(
    "reports no PROGRAM at project level",
    ({ sources }) => {
      expect(rejects(sources, "pou.program-count").args).toEqual({ found: 0 });
    },
  );
  it("reports several programs without attributing the error to one", () => {
    expect(rejects([main(), "PROGRAM Other END_PROGRAM"], "pou.program-count").args).toEqual({
      found: 2,
    });
  });
  it("rejects user function blocks until their implementation", () => {
    rejects([main(), "FUNCTION_BLOCK Block END_FUNCTION_BLOCK"], "pou.unsupported-kind", "Block");
  });

  it("uses the type collision kind for a user function block name", () => {
    expect(
      rejects(
        [main("", "Block: INT;"), "FUNCTION_BLOCK Block END_FUNCTION_BLOCK"],
        "decl.name-collision",
        "Main",
      ).args,
    ).toMatchObject({ kind: "type" });
  });

  it.each(["VAR_INPUT", "VAR_OUTPUT", "VAR_IN_OUT"])(
    "rejects %s in the PROGRAM, including an empty section",
    (section) => {
      rejects([`PROGRAM Main ${section} END_VAR END_PROGRAM`], "pou.invalid-section", "Main");
    },
  );
  it.each(["VAR_TEMP", "VAR_IN_OUT"])("rejects %s in functions", (section) => {
    rejects([main(), fn("", `${section} END_VAR`, "")], "pou.invalid-section", "F");
  });
  it.each(["TON", "TON_LTIME", "CTU_DINT"])("rejects %s instances in functions", (type) => {
    rejects(
      [main(), fn("", `VAR timer: ${type}; END_VAR`, "")],
      "pou.function-block-in-function",
      "F",
    );
  });
  it("rejects direct addresses in functions", () => {
    rejects([main(), fn("", "VAR pin AT %IX0.0: BOOL; END_VAR", "")], "pou.direct-address", "F");
  });
  it.each([
    [main("", "F: INT;"), fn(), "Main", "function"],
    [main(), fn("", "VAR main: INT; END_VAR"), "F", "type"],
    [main(), fn("", "VAR F: INT; END_VAR"), "F", "function"],
  ])("rejects a variable colliding with a POU", (program, source, pou, kind) => {
    expect(rejects([program, source], "decl.name-collision", pou).args).toMatchObject({ kind });
  });
  it.each([main("Main();"), main("x := Main();"), main("Main(A := 1);")])(
    "rejects calling the PROGRAM",
    (program) => {
      rejects([program], "call.program", "Main");
    },
  );
  it.each([
    "FUNCTION F : STRING END_FUNCTION",
    "FUNCTION F VAR_INPUT A: STRING; END_VAR END_FUNCTION",
  ])("rejects unsupported function types", (source) => {
    rejects([main(), source], "decl.unknown-type", "F");
  });
  it.each([
    ["FUNCTION F : INT\nF := ; END_FUNCTION", "syntax.expected-token"],
    ["(* header (* nested *) *) FUNCTION F : INT\nF := @; END_FUNCTION", "lex.invalid-character"],
    ["FUNCTION F : INT\nF := 1;", "syntax.missing-end"],
  ])("attributes parse failures to their source POU", (source, code) => {
    rejects([main(), source], code, "F");
  });
  it("requires exactly one POU per text", () => {
    rejects([main() + "\n" + fn()], "syntax.expected-token", "Main");
  });
  it("parses sections and a missing result type", () => {
    const parsed = parsePou(
      fn("", "VAR_INPUT A: INT; END_VAR VAR_OUTPUT Q: BOOL; END_VAR VAR local: REAL; END_VAR", ""),
    );
    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.ast?.resultType).toBeUndefined();
    expect(parsed.ast?.declarations.map((declaration) => declaration.section ?? "VAR")).toEqual([
      "VAR_INPUT",
      "VAR_OUTPUT",
      "VAR",
    ]);
  });
});

describe("user function call checking", () => {
  it.each(["x := F(1, 2);", "x := F(B := 2);", "F(A := 2);", "F(1, 2);", "F();"])(
    "accepts %s",
    (body) => {
      expect(compileProject([main(body), fn()]).diagnostics).toEqual([]);
    },
  );
  it.each(["x := F(1);", "F(1, 2, 3);"])("rejects positional arity errors: %s", (body) => {
    rejects([main(body), fn()], "call.argument-count", "Main");
  });
  it.each(["F(C := 1);", "F(A := 1, a := 2);", "F(A => x);", "F(Q := 1);", "F(Q => x, q => x);"])(
    "rejects invalid parameters: %s",
    (body) => {
      rejects(
        [main(body), fn("", "VAR_INPUT A: INT; END_VAR VAR_OUTPUT Q: INT; END_VAR")],
        "call.invalid-parameter",
        "Main",
      );
    },
  );
  it("requires formal syntax for a function with outputs", () => {
    rejects(
      [main("F(1);"), fn("", "VAR_INPUT A: INT; END_VAR VAR_OUTPUT Q: INT; END_VAR")],
      "call.formal-required",
      "Main",
    );
  });
  it.each(["F(A := 1, 2);", "F(1, B := 2);"])(
    "rejects mixing positional and formal parameters",
    (body) => {
      rejects([main(body), fn()], "syntax.expected-token", "Main");
    },
  );
  it("accepts only implicit input widening and contextual constants", () => {
    expect(
      compileProject([
        main("x := F(A := small);", "x: LINT; small: INT;"),
        fn("F := A;", "VAR_INPUT A: LINT; END_VAR", ": LINT"),
      ]).diagnostics,
    ).toEqual([]);
    rejects([main("F(A := DINT#1);"), fn()], "type.assign-mismatch", "Main");
    rejects([main("F(A := 40000);"), fn()], "type.invalid-constant", "Main");
  });
  it("checks output assignment direction, widening, range and writable targets", () => {
    const source = fn("", "VAR_OUTPUT Q: DINT; END_VAR", "");
    rejects([main("F(Q => x);"), source], "type.assign-mismatch", "Main");
    rejects([main("F(Q => missing);"), source], "name.undeclared", "Main");
    const boolOutput = fn("", "VAR_OUTPUT Q: BOOL; END_VAR", "");
    rejects(
      [main("F(Q => timer.Q);", "timer: TON;"), boolOutput],
      "fb.output-not-writable",
      "Main",
    );
    expect(compileProject([main("F(Q => x);", "x: LINT;"), source]).diagnostics).toEqual([]);
    expect(
      compileProject([main("F(Q => bits.1);", "bits: BYTE;"), boolOutput]).diagnostics,
    ).toEqual([]);
  });
  it("accepts a no-result function only as a statement", () => {
    const source = fn("", "", "");
    expect(compileProject([main("F();"), source]).diagnostics).toEqual([]);
    rejects([main("x := F();"), source], "call.no-result", "Main");
    rejects([main(), fn("F := G();"), "FUNCTION G END_FUNCTION"], "call.no-result", "F");
  });
  it.each(
    [
      [fn("F := F();")],
      [fn("F := G();"), "FUNCTION G : INT G := F(); END_FUNCTION"],
      [fn("F();", "", "")],
      [fn("G();", "", ""), "FUNCTION G F(); END_FUNCTION"],
    ].map((functions) => ({ functions })),
  )("rejects recursion even in functions unreachable from the program", ({ functions }) => {
    const result = compileProject([main(), ...functions]);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "pou.recursion",
        pou: expect.stringMatching(/F|G/),
        span: expect.any(Object),
      }),
    );
  });
  it("keeps standard formal inputs mandatory", () => {
    rejects([main("x := LIMIT(IN := 1);"), fn()], "call.argument-count", "Main");
  });
});

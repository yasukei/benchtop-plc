import { expect, it } from "vitest";
import { compileProject } from "./index.js";

const main = (
  body: string,
  declarations = "x : INT; wide : DINT; small : SINT; w : WORD; inst : B;",
) => `PROGRAM Main VAR ${declarations} END_VAR ${body} END_PROGRAM`;
const fn = `FUNCTION F : INT VAR_IN_OUT n : INT; END_VAR n := n + 1; F := n; END_FUNCTION`;
const block = `FUNCTION_BLOCK B VAR_IN_OUT n : INT; END_VAR VAR_INPUT input : INT; END_VAR END_FUNCTION_BLOCK`;

it.each(["F", "inst"])("checks every in-out argument of %s", (callee) => {
  for (const [argument, code] of [
    ["x + 1", "call.in-out-variable"],
    ["1", "call.in-out-variable"],
    ["INT#1", "call.in-out-variable"],
    ["(x)", "call.in-out-variable"],
    ["w.3", "call.in-out-variable"],
    ["inst.input", "call.in-out-variable"],
    ["wide", "call.in-out-type"],
    ["small", "call.in-out-type"],
    ["missing", "name.undeclared"],
    ["inst", "fb.instance-as-value"],
  ]) {
    const result = compileProject([main(`${callee}(n := ${argument});`), fn, block]);
    expect(result.ir, argument).toBeUndefined();
    expect(result.diagnostics, argument).toContainEqual(
      expect.objectContaining({ code, pou: "Main", sourceIndex: 0, span: expect.any(Object) }),
    );
  }
});

it.each(["F", "inst"])("requires every in-out on every call to %s", (callee) => {
  for (const call of [`${callee}();`, `${callee}(n := x); ${callee}();`]) {
    const result = compileProject([main(call), fn, block]);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "call.missing-in-out",
        args: { name: callee, parameter: "n" },
      }),
    );
  }
});

it.each([
  ["F(x);", "call.formal-required"],
  ["inst(x);", "fb.unsupported-call"],
  ["F(n := x, n := x);", "call.invalid-parameter"],
  ["inst(n := x, n := x);", "fb.duplicate-input"],
  ["F(n => x);", "call.invalid-parameter"],
  ["inst(n => x);", "fb.unknown-member"],
  ["x := inst.n;", "fb.unknown-member"],
  ["inst.n := x;", "fb.unknown-member"],
])("rejects invalid syntax and external in-out access: %s", (body, code) => {
  const result = compileProject([main(body), fn, block]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
});

it("does not accept CONSTANT variables or VAR_IN_OUT CONSTANT while constants are unsupported", () => {
  const sources = [
    [`PROGRAM Main VAR CONSTANT x : INT := 1; END_VAR F(n := x); END_PROGRAM`, fn],
    [main("F(n := x);"), `FUNCTION F VAR_IN_OUT CONSTANT n : INT; END_VAR END_FUNCTION`, block],
  ];
  for (const pous of sources) {
    const result = compileProject(pous);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "syntax.reserved-identifier" }),
    );
  }
});

it("accepts empty in-out sections and keeps alias slots out of monitored storage", () => {
  const result = compileProject([
    main("F(n := x); inst(n := x);"),
    fn,
    block,
    "FUNCTION Empty VAR_IN_OUT END_VAR END_FUNCTION",
  ]);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir?.functions?.[0]?.inOuts).toEqual([0]);
  expect(result.ir?.functionBlocks?.[0]?.inOuts).toEqual([0]);
  expect(result.ir?.instances?.[0]?.storage[0]).toEqual({ kind: "inOut" });
  expect(result.ir?.variables.map((variable) => variable.key)).not.toContain("INST.N");
  expect(JSON.parse(JSON.stringify(result.ir))).toEqual(result.ir);
});

it.each(["FUNCTION", "FUNCTION_BLOCK"])(
  "rejects initializers on %s in-outs, even in unused POUs",
  (kind) => {
    for (const initializer of ["0", "5", "1 + 2"]) {
      const source = `${kind} Callee
VAR_IN_OUT
  a, b : INT := ${initializer};
END_VAR
END_${kind}`;
      const result = compileProject(["PROGRAM Main END_PROGRAM", source]);
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics).toEqual([
        {
          code: "decl.in-out-initializer",
          severity: "error",
          args: { name: "a" },
          pou: "Callee",
          sourceIndex: 1,
          span: { line: 3, column: 17, endLine: 3, endColumn: 17 + initializer.length },
        },
      ]);
    }
  },
);

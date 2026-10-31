import { expect, it } from "vitest";
import {
  getStandardFunctionSignature,
  standardFunctions,
  type StandardFunction,
} from "@benchtop-plc/core";
import { compile, compileProject } from "./index.js";

it.each(Object.keys(standardFunctions) as StandardFunction[])(
  "accepts every registered formal input in %s",
  (name) => {
    const signature = getStandardFunctionSignature(name);
    const declarations = signature.inputNames!.map(
      (_, i) => `a${i}: ${signature.arguments[Math.min(i, signature.arguments.length - 1)]![0]};`,
    );
    const inputs = signature.inputNames!.map((input, i) => `${input} := a${i}`).reverse();
    const resultType =
      signature.result ??
      signature.arguments[signature.resultArgument ?? signature.genericStart ?? 0]![0];
    const call = `${name}(${inputs.join(", ")})`;
    const result = compile(
      `PROGRAM Main VAR ${declarations.join(" ")} resultValue: ${resultType}; END_VAR ${call}; resultValue := ${call}; END_PROGRAM`,
    );
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(result.ir).toBeDefined();
    expect(result.ir!.programs[0]!.body[0]).toMatchObject({
      kind: "call",
      call: { evaluationOrder: signature.inputNames!.map((_, i, names) => names.length - 1 - i) },
    });
  },
);

it.each([
  ["ABS(Bad := 1)", "call.invalid-parameter"],
  ["ABS(IN := 1, in := 2)", "call.invalid-parameter"],
  ["ABS(IN1 := 1)", "call.invalid-parameter"],
  ["NOT(Bad := BYTE#0)", "call.invalid-parameter"],
  ["NOT(IN := BYTE#0, OUT => n)", "call.invalid-parameter"],
  ["MAX(IN0 := 0, IN1 := 1)", "call.invalid-parameter"],
  ["MAX(IN01 := 1, IN2 := 2)", "call.invalid-parameter"],
  ["MAX(IN9007199254740992 := 1, IN1 := 2)", "call.invalid-parameter"],
  ["SEL(G := FALSE, IN0 := 1, IN2 := 2)", "call.invalid-parameter"],
  ["MUX(K := 0, IN0 := 1, IN0 := 2)", "call.invalid-parameter"],
  ["ABS(OUT => n)", "call.invalid-parameter"],
  ["ABS(IN := 1, OUT => n)", "call.invalid-parameter"],
  ["ABS()", "call.argument-count"],
  ["ABS(1, 2)", "call.argument-count"],
  ["LIMIT(IN := 5)", "call.argument-count"],
  ["MAX(IN1 := 1)", "call.argument-count"],
  ["MAX(IN1 := 1, IN3 := 3)", "call.argument-count"],
  ["MAX(IN1 := 1, IN2 := 2, IN4 := 4)", "call.argument-count"],
  ["MUX(IN0 := 1, IN1 := 2)", "call.argument-count"],
  ["MUX(K := 0, IN1 := 2)", "call.argument-count"],
  ["SEL(IN0 := 1, IN1 := 2)", "call.argument-count"],
  ["MAX(IN1 := 1, IN999999999 := 2)", "call.argument-count"],
  ["SQRT(IN := TRUE)", "call.argument-type"],
  ["INT_TO_REAL(IN := TRUE)", "call.argument-type"],
  ["SPLIT_DATE(IN := D#2024-01-01, YEAR => missing)", "name.undeclared"],
  ["SPLIT_DATE(IN := D#2024-01-01, YEAR => flag)", "type.assign-mismatch"],
])("reports only the cause of a rejected call: %s", (expression, code) => {
  const result = compile(
    `PROGRAM Main VAR n: INT; flag: BOOL; END_VAR n := ${expression}; END_PROGRAM`,
  );
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.map((d) => d.code)).toEqual([code]);
});

it("reports gaps in extensible input numbering without allocating sparse argument lists", () => {
  const result = compile("PROGRAM Main MAX(IN1 := 1, IN1000000000 := 2); END_PROGRAM");
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code: "call.argument-count",
      args: { name: "MAX", min: 1000000000, max: null, found: 2 },
    }),
  ]);
});

it.each([
  ["SEL(G := FALSE, IN0 := a, IN1 := b)", "call.argument-type"],
  ["SEL(G := FALSE, IN0 := r, IN1 := s)", "call.argument-type"],
  ["SEL(G := FALSE, IN0 := e, IN1 := f)", "call.argument-type"],
  ["SEL(G := FALSE, IN0 := a, IN1 := missing)", "name.undeclared"],
])(
  "does not infer an assignment type after failed formal selection inputs: %s",
  (expression, code) => {
    const result = compileProject(
      [
        `PROGRAM Main VAR n: INT; a: ARRAY[1..2] OF INT; b: ARRAY[1..3] OF INT;
    r: REF_TO INT; s: REF_TO BOOL; e: FirstEnum; f: SecondEnum; END_VAR
    n := ${expression}; END_PROGRAM`,
      ],
      ["TYPE FirstEnum : (One, Two); END_TYPE", "TYPE SecondEnum : (One, Two); END_TYPE"],
    );
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.map((d) => d.code)).toEqual([code]);
  },
);

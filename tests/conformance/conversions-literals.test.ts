import { describe, expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import { conversionFunctions, formatValue } from "@benchtop-plc/core";
import type { DataType, ScalarValue } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function program(declarations: string, body = "") {
  return compile(`PROGRAM P\nVAR ${declarations} END_VAR\n${body}\nEND_PROGRAM`);
}
function execute(declarations: string, body = "") {
  const result = program(declarations, body);
  expect(result.diagnostics).toEqual([]);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(result.ir!);
  const snapshot = runtime.scanOnce();
  const values: Record<string, ScalarValue> = {};
  snapshot.variables.forEach((cell, index) => {
    if (cell.kind === "scalar") values[result.ir!.variables[index]!.name] = cell.value;
  });
  return { runtime, values, ir: result.ir! };
}

describe("ADR 0013 conversions and constants", () => {
  it("widens values and keeps binary64 precision while rounding every REAL intermediate", () => {
    expect(
      execute(
        `i: INT := 7; u: UINT := 65535; d: DINT; r: REAL := 1.0; l: LREAL := 0.00000001;
      mixed: LREAL; realResult: LREAL; common: DINT; generic: REAL;`,
        `d := i; mixed := r + l; realResult := REAL#16777216.0 + REAL#1.0;
       common := i + u; generic := MAX(i, u, r);`,
      ).values,
    ).toMatchObject({
      d: 7,
      mixed: 1.00000001,
      realResult: 16777216,
      common: 65542,
      generic: 65535,
    });
  });
  it.each([
    ["x: INT; y: DINT;", "x := y;"],
    ["x: REAL; y: LREAL;", "x := y;"],
    ["x: REAL; y: DINT;", "x := y;"],
    ["x: INT; y: UINT;", "x := y;"],
    ["counter: CTU; y: DINT;", "counter(PV := y);"],
    ["i: INT; y: DINT;", "FOR i := 0 TO y DO END_FOR;"],
    ["i: INT;", "CASE i OF DINT#1: END_CASE;"],
    ["x: REAL;", "x := INT_TO_REAL(DINT#1);"],
  ])("requires explicit conversion into typed slots: %s %s", (declarations, body) => {
    expect(program(declarations, body).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "type.assign-mismatch",
        args: expect.objectContaining({ hint: "explicit-conversion" }),
      }),
    );
  });
  it.each([
    ["x: INT := 40000;", ""],
    ["x: INT := 30000 + 30000;", ""],
    ["x: UINT := -1;", ""],
    ["i: INT; r: LREAL;", "r := i + 40000;"],
    ["i: INT;", "i := MAX(i, 40000);"],
    ["b: BOOL := 2;", ""],
    ["i: INT;", "FOR i := 0 TO 40000 DO END_FOR;"],
    ["i: INT;", "CASE i OF 40000: END_CASE;"],
    ["counter: CTU;", "counter(PV := 40000);"],
    ["x: INT := INT#40000;", ""],
    ["x: LREAL := REAL#1e39;", ""],
    ["x: INT := INT#1 / INT#0;", ""],
    ["x: REAL := REAL#3e38 * REAL#2.0;", ""],
  ])("rejects invalid constants at their positions: %s %s", (declarations, body) => {
    expect(program(declarations, body).diagnostics).toContainEqual(
      expect.objectContaining({ code: "type.invalid-constant" }),
    );
  });
  it.each(["1e99999999", "1e-99999999", "REAL#1e99999999", "LREAL#1e-99999999"])(
    "rejects an excessive decimal scale in %s",
    (source) => {
      expect(program(`x: LREAL := ${source};`).diagnostics).toEqual([
        expect.objectContaining({ code: "type.invalid-constant" }),
      ]);
    },
  );
  it.each([
    ["5.5 MOD 2", "LREAL", "DINT"],
    ["5 MOD 2.5", "DINT", "LREAL"],
    ["5 MOD (1 + 1.5)", "DINT", "LREAL"],
    ["LREAL#5.5 MOD 2", "LREAL", "LREAL"],
  ])("reports a type mismatch for %s", (source, left, right) => {
    expect(program(`x: LREAL := ${source};`).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "type.operand-mismatch",
        args: { operator: "MOD", left, right },
      }),
    );
  });
  it("keeps integer MOD exact inside arithmetic containing a real sibling", () => {
    expect(execute("x: LREAL := (5 MOD 2) + 0.5;").values.x).toBe(1.5);
  });
  it.each(["BOOL", "TIME"])(
    "includes an available %s-to-integer conversion in the hint",
    (from) => {
      expect(program(`x: INT; source: ${from};`, "x := source;").diagnostics).toContainEqual(
        expect.objectContaining({
          code: "type.assign-mismatch",
          args: { from, to: "INT", hint: "explicit-conversion" },
        }),
      );
    },
  );
  it("marks the literal rather than the assignment for a local range failure", () => {
    expect(program("i: INT; l: LREAL;", "l := i + 40000;").diagnostics).toEqual([
      {
        code: "type.invalid-constant",
        severity: "error",
        args: {},
        span: { line: 3, column: 10, endLine: 3, endColumn: 15 },
      },
    ]);
  });
  it("materializes exact arithmetic once, independent of intermediate ranges and precision", () => {
    expect(
      execute(
        `a: INT := 1 + 2; u: UINT := 40000; wrapped: INT := INT#32767 + INT#1;
      half: LREAL := 1 / 2; exact: INT := 9007199254740993 - 9007199254740992;
      small: REAL := (1e400 + 1e400) / 1e400; fraction: LREAL := 0.1 + 0.2;
      typed: LREAL := LREAL#0.1 + LREAL#0.2; b: BOOL := 1; order: BOOL := FALSE < TRUE;
      i: INT; total: INT; t: TIME := T#1s; next: LREAL;`,
        `FOR i := 5 TO 1 BY -2 DO total := total + i; END_FOR; t := -t; next := i + 1.5;`,
      ).values,
    ).toMatchObject({
      a: 3,
      u: 40000,
      wrapped: -32768,
      half: 0,
      exact: 1,
      small: 2,
      fraction: 0.3,
      typed: 0.1 + 0.2,
      b: true,
      order: true,
      total: 9,
      t: -1000,
      next: 0.5,
    });
  });
  it("rounds directly to binary32/64 at ties, subnormals and signed zero", () => {
    const { values } = execute(`a: REAL := REAL#1.000000178813934326171874999;
      b: REAL := 1.000000178813934326171874999; tie: REAL := 1.000000059604644775390625;
      up: REAL := 1.000000059604644775390626; sub: REAL := 1.401298464324817e-45;
      tiny: LREAL := 4.9406564584124654e-324; zero: REAL := -0.0;`);
    expect(formatValue("REAL", Number(values.a))).toBe("1.0000001");
    expect(values).toMatchObject({
      a: 1 + 2 ** -23,
      b: 1 + 2 ** -23,
      tie: 1,
      up: 1 + 2 ** -23,
      sub: 2 ** -149,
      tiny: Number.MIN_VALUE,
      zero: 0,
    });
    expect(Object.is(values.zero, -0)).toBe(false);
  });
  it("supports typed literals, BOOL constants and independent TIME factors", () => {
    expect(
      execute(
        `u: UINT := UINT#16#FF; i: INT := INT#-5; r: REAL := REAL#1.5;
      b: BOOL := BOOL#1; c: BOOL := BOOL#FALSE; t: TIME;`,
        "t := T#2s * 2; IF 1 THEN b := 0; END_IF;",
      ).values,
    ).toMatchObject({ u: 255, i: -5, r: 1.5, b: false, c: false, t: 4000 });
    expect(program("u: UINT;", "u := -u;").diagnostics[0]?.code).toBe("type.operand-mismatch");
    expect(program("i: INT := 8#17;").diagnostics[0]?.code).toBe("lex.malformed-number");
  });
  it.each([
    ["REAL_TO_INT(2.5)", 2],
    ["REAL_TO_INT(-2.5)", -2],
    ["REAL_TO_INT(40000.0)", -25536],
    ["DINT_TO_INT(40000)", -25536],
    ["TIME_TO_INT(T#40s)", -25536],
    ["TO_INT(300)", 300],
  ])("evaluates conversion %s at compile time and runtime", (expression, expected) => {
    expect(
      execute(`initial: INT := ${expression}; result: INT;`, `result := ${expression};`).values,
    ).toEqual({ initial: expected, result: expected });
  });
  it("compiles and executes every conversion opcode with its declared source and destination", () => {
    for (const [name, signature] of Object.entries(conversionFunctions)) {
      for (const from of signature.arguments[0]!) {
        const input = from === "BOOL" ? "TRUE" : from === "TIME" ? "T#3ms" : `${from}#3`;
        const { values } = execute(
          `source: ${from} := ${input}; result: ${signature.result};`,
          `result := ${name}(source);`,
        );
        expect(values.result, `${name}(${from})`).toBe(from === "BOOL" ? 1 : 3);
      }
    }
  });
  it.each<[DataType, string, number]>([
    ["INT", "LREAL_TO_INT(-3.5)", -4],
    ["UINT", "INT_TO_UINT(-1)", 65535],
    ["DINT", "LREAL_TO_DINT(2147483648.0)", -2147483648],
    ["REAL", "DINT_TO_REAL(16777217)", 16777216],
    ["TIME", "DINT_TO_TIME(-40000)", -40000],
  ])("converts %s using rounding and wrapping", (type, expression, expected) => {
    expect(execute(`x: ${type};`, `x := ${expression};`).values.x).toBe(expected);
  });
  it("faults on runtime REAL conversion overflow and rejects constant overflow", () => {
    const { runtime } = execute(
      "large: LREAL := 1e39; result: REAL;",
      "result := LREAL_TO_REAL(large);",
    );
    expect(runtime.diagnostic?.code).toBe("runtime.invalid-value");
    expect(program("result: REAL := LREAL_TO_REAL(LREAL#1e39);").diagnostics[0]?.code).toBe(
      "type.invalid-constant",
    );
  });
  it.each(["INT_TO_BOOL", "REAL_TO_BOOL", "TIME_TO_REAL", "BOOL_TO_REAL"])(
    "does not add conversion %s",
    (name) => {
      expect(program("x: INT;", `x := ${name}(1);`).diagnostics[0]?.code).toBe(
        "call.unknown-function",
      );
    },
  );
});

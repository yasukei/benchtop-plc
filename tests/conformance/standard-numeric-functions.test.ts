import { describe, expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import type { ScalarValue } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function program(declarations: string, body = "") {
  return compile(`PROGRAM P VAR ${declarations} END_VAR\n${body}\nEND_PROGRAM`);
}
function execute(type: string, expression: string, declarations = "") {
  const compiled = program(`result: ${type}; ${declarations}`, `result := ${expression};`);
  expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(compiled.ir).toBeDefined();
  const ir = compiled.ir!;
  expect(JSON.parse(JSON.stringify(ir))).toEqual(ir);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  const snapshot = runtime.step();
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  const result = snapshot.variables[0]!;
  if (result.kind !== "scalar") throw new Error("Expected scalar");
  return { result: result.value, runtime, ir };
}

describe("standard numeric, bit and elementary functions", () => {
  it.each<[string, string, ScalarValue]>([
    ["LREAL", "2.0 ** 10", 1024],
    ["LREAL", "2 ** 10", 1024],
    ["LREAL", "EXPT(2, 10)", 1024],
    ["REAL", "EXPT(REAL#2, LINT#10)", 1024],
    ["REAL", "REAL#2 ** ULINT#10", 1024],
    ["LREAL", "EXPT(-1.0, ULINT#18446744073709551615)", -1],
    ["REAL", "REAL#-1 ** ULINT#18446744073709551615", -1],
    ["LREAL", "(-1.0) ** LINT#-9223372036854775807", -1],
    ["LREAL", "2 * 3 ** 2 + 1", 19],
    ["LREAL", "2 ** 3 ** 2", 64],
    ["LREAL", "-2 ** 2", -4],
    ["LREAL", "(-2) ** 2", 4],
    ["LREAL", "2 ** -2", 0.25],
    ["LREAL", "SQRT(9)", 3],
    ["LREAL", "SQRT(18446744073709551615)", 4294967296],
    ["REAL", "SQRT(REAL#9)", 3],
    ["LREAL", "LN(1.0)", 0],
    ["LREAL", "LOG(100.0)", 2],
    ["LREAL", "EXP(0.0)", 1],
    ["LREAL", "SIN(0.0)", 0],
    ["LREAL", "COS(0.0)", 1],
    ["LREAL", "TAN(0.0)", 0],
    ["LREAL", "ASIN(0.0)", 0],
    ["LREAL", "ACOS(1.0)", 0],
    ["LREAL", "ATAN(0.0)", 0],
    ["LREAL", "ATAN2(REAL#0, LREAL#1)", 0],
    ["DINT", "ADD(1, 2, 3)", 6],
    ["INT", "ADD(INT#32767, 1)", -32768],
    ["UDINT", "MUL(UDINT#4294967295, UDINT#4294967295)", 1],
    ["LINT", "ADD(LINT#9223372036854775807, 1)", "-9223372036854775808"],
    ["LINT", "SUB(LINT#9007199254740993, 1)", "9007199254740992"],
    ["ULINT", "MUL(ULINT#18446744073709551615, ULINT#18446744073709551615)", "1"],
    ["LINT", "DIV(LINT#-9223372036854775808, -1)", "-9223372036854775808"],
    ["INT", "DIV(INT#-7, 2)", -3],
    ["LREAL", "DIV(7.0, 2.0)", 3.5],
    ["LINT", "MOD(LINT#-7, 2)", "-1"],
    ["LINT", "MOD(LINT#7, 0)", "0"],
    ["REAL", "ADD(REAL#16777216, 1, REAL#-16777216)", 0],
    ["LREAL", "ADD(LREAL#16777216, 1, LREAL#-16777216)", 1],
    ["BYTE", "ROL(BYTE#2#1000_0001, 1)", 3],
    ["WORD", "SHL(WORD#16#8001, 1)", 2],
    ["LWORD", "ROR(LWORD#1, 1)", "9223372036854775808"],
    ["LWORD", "ROL(LWORD#16#8000000000000001, ULINT#18446744073709551615)", "13835058055282163712"],
    ["BYTE", "SHR(BYTE#255, LINT#8)", 0],
    ["LWORD", "SHL(LWORD#1, ULINT#18446744073709551615)", "0"],
    ["BOOL", "ROL(TRUE, 99)", true],
    ["BOOL", "SHR(TRUE, 1)", false],
    ["DWORD", "AND(DWORD#16#FFFFFFFF, WORD#16#FF00, BYTE#16#FF)", 0],
    ["DWORD", "OR(DWORD#16#80000000, BYTE#1, TRUE)", 2147483649],
    ["LWORD", "XOR(LWORD#16#FFFFFFFFFFFFFFFF, LWORD#1, LWORD#2)", "18446744073709551612"],
    ["LWORD", "NOT(LWORD#0)", "18446744073709551615"],
    ["BOOL", "NOT(TRUE)", false],
    ["BOOL", "AND(TRUE, TRUE, FALSE)", false],
    ["BOOL", "OR(FALSE, FALSE, TRUE)", true],
    ["BOOL", "XOR(TRUE, TRUE, TRUE)", true],
    ["DINT", "MUX(1, 10, 20, 30)", 20],
    ["BOOL", "MUX(ULINT#1, FALSE, TRUE)", true],
    ["BOOL", "MAX(FALSE, TRUE)", true],
    ["BOOL", "MIN(TRUE, FALSE)", false],
    ["BOOL", "MAX(FALSE, 1)", true],
    ["BOOL", "LIMIT(0, FALSE, 1)", false],
    ["LINT", "MAX(LINT#9007199254740992, LINT#9007199254740993)", "9007199254740993"],
    ["LTIME", "MIN(T#1ms, LT#999999ns)", "999999"],
    ["LDATE", "MAX(D#1970-01-02, LD#1970-01-03)", "172800000000000"],
    ["LTOD", "SEL(TRUE, TOD#00:00:00, LTOD#00:00:00.000000001)", "1"],
    ["LDT", "MUX(1, DT#1970-01-01-00:00:00, LDT#1970-01-01-00:00:00.000000001)", "1"],
    ["LINT", "MOVE(LINT#9007199254740993)", "9007199254740993"],
    ["BOOL", "GT(TRUE, FALSE)", true],
    ["BOOL", "GE(TRUE, TRUE, FALSE)", true],
    ["BOOL", "EQ(FALSE, FALSE, FALSE)", true],
    ["BOOL", "LE(FALSE, TRUE, TRUE)", true],
    ["BOOL", "LT(LINT#9007199254740992, LINT#9007199254740993)", true],
    ["BOOL", "NE(LWORD#16#FFFFFFFFFFFFFFFF, LWORD#16#FFFFFFFFFFFFFFFE)", true],
    ["BOOL", "EQ(T#1ms, LT#1000000ns)", true],
    ["BOOL", "LT(D#1970-01-01, LD#1970-01-02)", true],
    ["INT", "TRUNC_INT(-2.7)", -2],
    ["INT", "REAL_TRUNC_INT(-2.7)", -2],
    ["LINT", "LREAL_TRUNC_LINT(9007199254740992.0)", "9007199254740992"],
    ["INT", "TRUNC_INT(40000.9)", -25536],
    ["USINT", "TRUNC_USINT(-1.7)", 255],
    ["UINT", "WORD_BCD_TO_UINT(WORD#16#1234)", 1234],
    ["WORD", "UINT_TO_BCD_WORD(1234)", 0x1234],
    ["ULINT", "LWORD_BCD_TO_ULINT(LWORD#16#9999999999999999)", "9999999999999999"],
    ["LWORD", "ULINT_TO_BCD_LWORD(ULINT#9999999999999999)", "11068046444225730969"],
  ])("executes %s result from %s", (type, expression, expected) => {
    const { result, runtime } = execute(type, expression);
    expect(runtime.diagnostic).toBeNull();
    expect(result).toBe(expected);
  });

  it("preserves parenthesized unary NOT in constant initializers and CASE labels", () => {
    const { result, runtime } = execute("BOOL", "b", "b: BOOL := NOT(TRUE);");
    expect(runtime.diagnostic).toBeNull();
    expect(result).toBe(false);
    const compiled = program(
      "b: BYTE := NOT(BYTE#0); x: INT;",
      "CASE x OF BYTE_TO_INT(NOT(BYTE#255)): x := 1; END_CASE;",
    );
    expect(compiled.diagnostics).toEqual([]);
    expect(compiled.ir?.variables[0]).toMatchObject({ initialValue: 255 });
  });

  it("infers generic values separately from selectors, counts and destinations", () => {
    const { result, ir } = execute("INT", "LIMIT(0, x_int, 1000)", "x_int: INT := 4;");
    expect(result).toBe(4);
    expect(ir.programs[0]!.body[0]).toMatchObject({
      value: {
        dataType: "INT",
        args: [{ dataType: "INT" }, { dataType: "INT" }, { dataType: "INT" }],
      },
    });
    expect(execute("BYTE", "SHL(b, n)", "b: BYTE := 1; n: ULINT := 1;").result).toBe(2);
    expect(execute("USINT", "MUX(k, u, 2)", "k: LINT := 1; u: USINT := 1;").result).toBe(2);
    expect(execute("REAL", "EXPT(r, n)", "r: REAL := 2; n: LINT := 10;").result).toBe(1024);
    for (const expression of ["MAX(i, u, r)", "MAX(r, i, u)", "MAX(u, r, i)"])
      expect(execute("REAL", expression, "i: INT := 1; u: UINT := 2; r: REAL := 3;").result).toBe(
        3,
      );
  });

  it.each([
    ["x: USINT;", "x := MAX(1, x, 300);"],
    ["x: REAL;", "x := x MOD 2.0;"],
    ["x: REAL;", "x := MOD(x, 2.0);"],
    ["x: INT;", "x := TRUNC(2.7);"],
    ["x: INT;", "x := TRUNC_INT(x);"],
    ["x: LREAL; i: INT;", "x := EXPT(i, 2);"],
    ["x: LREAL; i: INT;", "x := i ** 2;"],
    ["x: BYTE;", "x := SHL(x, 1.5);"],
    ["x: INT;", "x := AND(x, 1);"],
    ["x: LINT; u: ULINT;", "x := MAX(x, u);"],
    ["x: BOOL;", "x := EQ(FALSE, 2);"],
    ["x: BOOL;", "x := NE(1, 2, 3);"],
    ["x: INT;", "x := MUX(0, 1);"],
    ["x: INT;", "x := ADD(1);"],
    ["x: LREAL;", "x := ATAN2(1.0);"],
  ])("rejects invalid signatures: %s %s", (declarations, body) => {
    const compiled = program(declarations, body);
    expect(compiled.ir).toBeUndefined();
    expect(compiled.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });

  it.each([
    ["DINT", "ABS(1)"],
    ["LREAL", "SQRT(4.0)"],
    ["INT", "TRUNC_INT(2.7)"],
    ["INT", "ADD(INT#1, 2)"],
    ["WORD", "UINT_TO_BCD_WORD(12)"],
    ["BOOL", "EQ(1, 1)"],
  ])("does not allow %s initializer function %s", (type, expression) => {
    expect(program(`x: ${type} := ${expression};`).diagnostics).toContainEqual(
      expect.objectContaining({ code: "decl.nonconstant-initializer" }),
    );
  });

  it.each([
    ["LREAL", "SQRT(-1.0)", "runtime.invalid-value"],
    ["LREAL", "LN(0.0)", "runtime.invalid-value"],
    ["REAL", "EXP(REAL#100)", "runtime.invalid-value"],
    ["LREAL", "EXPT(-1.0, 0.5)", "runtime.invalid-value"],
    ["INT", "DIV(INT#1, 0)", "runtime.division-by-zero"],
    ["LINT", "DIV(LINT#1, 0)", "runtime.division-by-zero"],
    ["DINT", "MUX(5, 10, 20)", "runtime.invalid-value"],
    ["DINT", "MUX(-1, 10, 20)", "runtime.invalid-value"],
    ["DINT", "MUX(ULINT#18446744073709551615, 10, 20)", "runtime.invalid-value"],
    ["UINT", "WORD_BCD_TO_UINT(WORD#16#1A00)", "runtime.invalid-value"],
    ["LINT", "LWORD_BCD_TO_LINT(LWORD#16#A000000000000000)", "runtime.invalid-value"],
    ["BYTE", "SHL(BYTE#1, -1)", "runtime.invalid-value"],
  ])("faults at %s call %s", (type, expression, code) => {
    const { runtime } = execute(type, expression);
    expect(runtime.state).toBe("FAULT");
    expect(runtime.diagnostic).toMatchObject({
      code,
      span: { line: 2, column: 11, endColumn: 11 + expression.length },
    });
  });
});

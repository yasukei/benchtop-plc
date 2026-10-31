import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable, type ScalarValue } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function execute(sources: string[]) {
  const compiled = compileProject(sources);
  expect(compiled.diagnostics).toEqual([]);
  const ir = structuredClone(compiled.ir!);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  runtime.step();
  expect(runtime.diagnostic).toBeNull();
  const value = (name: string) =>
    snapshotVariable(
      runtime.snapshot(),
      ir.variables.findIndex((v) => v.key === `MAININSTANCE.${name.toUpperCase()}`),
    );
  return { ir, value };
}

it.each<[string, string, string, ScalarValue]>([
  ["DINT", "ABS(IN := -3)", "ABS(-3)", 3],
  ["LREAL", "SQRT(IN := 9.0)", "SQRT(9.0)", 3],
  ["LREAL", "ATAN2(X := 1.0, Y := 0.0)", "ATAN2(0.0, 1.0)", 0],
  ["DINT", "ADD(IN3 := 3, IN1 := 1, IN2 := 2)", "ADD(1, 2, 3)", 6],
  ["DINT", "MUL(IN2 := 3, IN3 := 4, IN1 := 2)", "MUL(2, 3, 4)", 24],
  ["DINT", "SUB(IN2 := 4, IN1 := 9)", "SUB(9, 4)", 5],
  ["DINT", "DIV(IN2 := 2, IN1 := 9)", "DIV(9, 2)", 4],
  ["DINT", "MOD(IN2 := 4, IN1 := 9)", "MOD(9, 4)", 1],
  ["LREAL", "EXPT(IN2 := 3, IN1 := 2.0)", "EXPT(2.0, 3)", 8],
  ["WORD", "SHL(N := 2, IN := WORD#1)", "SHL(WORD#1, 2)", 4],
  ["WORD", "SHR(N := 2, IN := WORD#16)", "SHR(WORD#16, 2)", 4],
  ["BYTE", "ROL(N := 1, IN := BYTE#16#81)", "ROL(BYTE#16#81, 1)", 3],
  ["BYTE", "ROR(N := 1, IN := BYTE#1)", "ROR(BYTE#1, 1)", 128],
  ["WORD", "AND(IN2 := WORD#15, IN1 := WORD#240)", "AND(WORD#240, WORD#15)", 0],
  ["WORD", "OR(IN3 := WORD#4, IN1 := WORD#1, IN2 := WORD#2)", "OR(WORD#1, WORD#2, WORD#4)", 7],
  ["BOOL", "XOR(IN2 := TRUE, IN1 := TRUE, IN3 := TRUE)", "XOR(TRUE, TRUE, TRUE)", true],
  ["BYTE", "NOT(IN := BYTE#0)", "NOT(BYTE#0)", 255],
  ["DINT", "MIN(IN2 := 3, IN3 := 2, IN1 := 1)", "MIN(1, 3, 2)", 1],
  ["DINT", "MAX(IN3 := 2, IN2 := 3, IN1 := 1)", "MAX(1, 3, 2)", 3],
  ["DINT", "LIMIT(MX := 3, IN := 5, MN := 0)", "LIMIT(0, 5, 3)", 3],
  ["DINT", "SEL(IN1 := 2, G := FALSE, IN0 := 1)", "SEL(FALSE, 1, 2)", 1],
  ["DINT", "MUX(IN2 := 30, IN0 := 10, K := 2, IN1 := 20)", "MUX(2, 10, 20, 30)", 30],
  ["DINT", "MOVE(in := 5)", "MOVE(5)", 5],
  ["BOOL", "GT(IN3 := 1, IN1 := 3, IN2 := 2)", "GT(3, 2, 1)", true],
  ["BOOL", "GE(IN2 := 3, IN1 := 3)", "GE(3, 3)", true],
  ["BOOL", "EQ(IN3 := 1, IN2 := 1, IN1 := 1)", "EQ(1, 1, 1)", true],
  ["BOOL", "LE(IN2 := 3, IN1 := 3)", "LE(3, 3)", true],
  ["BOOL", "LT(IN3 := 3, IN1 := 1, IN2 := 2)", "LT(1, 2, 3)", true],
  ["BOOL", "NE(IN2 := 2, IN1 := 1)", "NE(1, 2)", true],
  ["INT", "LEN(IN := 'hello')", "LEN('hello')", 5],
  ["STRING", "LEFT(L := 2, IN := 'hello')", "LEFT('hello', 2)", "he"],
  ["STRING", "RIGHT(L := 2, IN := 'hello')", "RIGHT('hello', 2)", "lo"],
  ["STRING", "MID(P := 2, IN := 'hello', L := 3)", "MID('hello', 3, 2)", "ell"],
  ["STRING", "CONCAT(IN3 := 'c', IN1 := 'a', IN2 := 'b')", "CONCAT('a', 'b', 'c')", "abc"],
  ["STRING", "INSERT(P := 2, IN2 := 'x', IN1 := 'abcd')", "INSERT('abcd', 'x', 2)", "abxcd"],
  ["STRING", "DELETE(P := 2, L := 2, IN := 'abcd')", "DELETE('abcd', 2, 2)", "ad"],
  [
    "STRING",
    "REPLACE(P := 2, L := 2, IN2 := 'x', IN1 := 'abcd')",
    "REPLACE('abcd', 'x', 2, 2)",
    "axd",
  ],
  ["INT", "FIND(IN2 := 'bc', IN1 := 'abcd')", "FIND('abcd', 'bc')", 2],
  ["REAL", "INT_TO_REAL(IN := INT#1)", "INT_TO_REAL(INT#1)", 1],
  ["INT", "TO_INT(IN := REAL#2.5)", "TO_INT(REAL#2.5)", 2],
  ["INT", "TRUNC_INT(IN := -2.7)", "TRUNC_INT(-2.7)", -2],
  ["UINT", "WORD_BCD_TO_UINT(IN := WORD#16#1234)", "WORD_BCD_TO_UINT(WORD#16#1234)", 1234],
  ["WORD", "UINT_TO_BCD_WORD(IN := UINT#1234)", "UINT_TO_BCD_WORD(UINT#1234)", 4660],
  ["INT", "STRING_TO_INT(IN := '12')", "STRING_TO_INT('12')", 12],
  ["STRING", "INT_TO_STRING(IN := INT#-3)", "INT_TO_STRING(INT#-3)", "-3"],
])("executes formal %s call %s like %s", (type, formal, positional, expected) => {
  const { value } = execute([
    `PROGRAM Main VAR formalResult, positionalResult: ${type}; END_VAR
    formalResult := ${formal}; positionalResult := ${positional}; END_PROGRAM`,
  ]);
  expect(value("formalResult")).toMatchObject({ value: expected });
  expect(value("positionalResult")).toMatchObject({ value: expected });
});

it("evaluates reordered extensible inputs once each in source order", () => {
  const { value, ir } = execute([
    `PROGRAM Main VAR order: DINT; resultValue: INT; END_VAR
    resultValue := MAX(
      IN3 := Mark(digit := 3, state := order),
      IN1 := Mark(digit := 1, state := order),
      IN2 := Mark(digit := 2, state := order)); END_PROGRAM`,
    `FUNCTION Mark : INT VAR_INPUT digit: INT; END_VAR VAR_IN_OUT state: DINT; END_VAR
    state := state * 10 + digit; Mark := digit; END_FUNCTION`,
  ]);
  expect(value("order")).toMatchObject({ value: 312 });
  expect(value("resultValue")).toMatchObject({ value: 3 });
  expect(ir.programs[0]!.body[0]).toMatchObject({ value: { evaluationOrder: [2, 0, 1] } });
});

it("evaluates both SEL values and its selector in source order", () => {
  const { value } = execute([
    `PROGRAM Main VAR order: DINT; resultValue: INT; END_VAR
    resultValue := SEL(
      IN1 := Mark(digit := 1, state := order),
      G := Mark(digit := 2, state := order) = 2,
      IN0 := Mark(digit := 3, state := order)); END_PROGRAM`,
    `FUNCTION Mark : INT VAR_INPUT digit: INT; END_VAR VAR_IN_OUT state: DINT; END_VAR
    state := state * 10 + digit; Mark := digit; END_FUNCTION`,
  ]);
  expect(value("order")).toMatchObject({ value: 123 });
  expect(value("resultValue")).toMatchObject({ value: 1 });
});

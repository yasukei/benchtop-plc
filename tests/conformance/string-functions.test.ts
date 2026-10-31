import { expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function execute(type: string, expression: string, declarations = "") {
  const compiled = compile(
    `PROGRAM Main VAR result : ${type}; ${declarations} END_VAR\nresult := ${expression};\nEND_PROGRAM`,
  );
  expect(compiled.diagnostics).toEqual([]);
  const ir = JSON.parse(JSON.stringify(compiled.ir)) as NonNullable<typeof compiled.ir>;
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  return { runtime, value: runtime.step().variables[0] };
}

it.each([
  ["STRING", "MID('ABC', 2, 5)"],
  ["STRING", "LEFT('ABC', -1)"],
  ["STRING", "INSERT('ABC', 'X', 4)"],
  ["STRING", "DELETE('', 0, 1)"],
  ["WSTRING", 'REPLACE("ABC", "X", 1, 0)'],
  ["INT", "STRING_TO_INT('bad')"],
  ["INT", "STRING_TO_INT('32768')"],
  ["INT", 'WSTRING_TO_INT("-32769")'],
  ["TIME", "STRING_TO_TIME('TIME#2147483648ms')"],
  ["CHAR", "STRING_TO_CHAR('')"],
  ["WCHAR", 'WSTRING_TO_WCHAR("")'],
  ["STRING", 'WSTRING_TO_STRING("Ω")'],
  ["CHAR", 'WCHAR_TO_CHAR(WCHAR#"Ω")'],
  ["INT", "TO_INT('bad')"],
])("faults at the call span for %s := %s", (type, expression) => {
  const { runtime } = execute(type, expression);
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.invalid-value",
    pou: "Main",
    span: { line: 2, column: 11, endLine: 2, endColumn: 11 + expression.length },
  });
});

it.each([
  ["STRING", "DELETE('ABC', 5, 2)", "A"],
  ["WSTRING", 'CONCAT("Ω", "Ä", "B")', "ΩÄB"],
  ["WSTRING", 'INSERT("ABC", "Ω", ULINT#2)', "ABΩC"],
  ["WSTRING", 'REPLACE("ABC", "Ω", LINT#5, USINT#2)', "AΩ"],
  ["WSTRING", 'MID("ABC", ULINT#18446744073709551615, SINT#2)', "BC"],
  ["INT", 'FIND("ΩABC", "BC")', 3],
  ["WSTRING", "TO_WSTRING(INT#-42)", "-42"],
  ["STRING", "TO_STRING(TRUE)", "TRUE"],
  ["WCHAR", "TO_WCHAR(WORD#16#03A9)", "Ω"],
  ["WORD", 'TO_WORD(WCHAR#"Ω")', 937],
  ["BYTE", "TO_BYTE(CHAR#'A')", 65],
  ["CHAR", "TO_CHAR(BYTE#65)", "A"],
  ["STRING", "TO_STRING('123')", "123"],
  ["CHAR", "TO_CHAR(CHAR#'A')", "A"],
  ["STRING[2]", "INT_TO_STRING(-123)", "-1"],
  ["STRING", "LEFT(text, UINT#5)", "abc"],
])("executes %s := %s", (type, expression, expected) => {
  const { runtime, value } = execute(String(type), String(expression), "text : STRING := 'abc';");
  expect(runtime.diagnostic).toBeNull();
  expect(value).toMatchObject({ kind: "scalar", value: expected });
});

it("keeps the calendar CONCAT families working beside CONCAT", () => {
  expect(execute("DATE", "CONCAT_DATE(2024, 2, 29)").runtime.diagnostic).toBeNull();
  expect(execute("TOD", "CONCAT_TOD(12, 0, 0, 0)").runtime.diagnostic).toBeNull();
});

it.each([
  ["INT", "LEN(ch)", 1],
  ["STRING", "LEFT(ch, 0)", ""],
  ["STRING", "RIGHT(CHAR#'X', 0)", ""],
  ["STRING", "MID(ch, 0, 1)", ""],
  ["STRING", "DELETE(ch, 1, 1)", ""],
  ["STRING", "CONCAT(ch, CHAR#'X')", "AX"],
  ["STRING", "CONCAT(text, ch, CHAR#'X')", "ABAX"],
  ["STRING", "INSERT(ch, CHAR#'X', 0)", "XA"],
  ["STRING", "INSERT(text, ch, 1)", "AAB"],
  ["STRING", "REPLACE(ch, CHAR#'X', 0, 1)", "XA"],
  ["STRING", "REPLACE(text, ch, 1, 2)", "AA"],
  ["INT", "FIND(text, ch)", 1],
  ["INT", "LEN(wc)", 1],
  ["WSTRING", "LEFT(wc, 0)", ""],
  ["WSTRING", 'RIGHT(WCHAR#"Ω", 0)', ""],
  ["WSTRING", "MID(wc, 0, 1)", ""],
  ["WSTRING", "DELETE(wc, 1, 1)", ""],
  ["WSTRING", 'CONCAT(wc, WCHAR#"Ω")', "ΩΩ"],
  ["WSTRING", 'CONCAT(wide, wc, WCHAR#"Ω")', "ΩBΩΩ"],
  ["WSTRING", 'INSERT(wc, WCHAR#"X", 0)', "XΩ"],
  ["WSTRING", "INSERT(wide, wc, 1)", "ΩΩB"],
  ["WSTRING", 'REPLACE(wc, WCHAR#"X", 0, 1)', "XΩ"],
  ["WSTRING", "REPLACE(wide, wc, 1, 2)", "ΩΩ"],
  ["INT", "FIND(wide, wc)", 1],
  ["STRING[1]", "CONCAT(ch, ch)", "A"],
  ["WSTRING[1]", "CONCAT(wc, wc)", "Ω"],
  ["STRING", "CONCAT(DELETE(ch, 1, 1), ch)", "A"],
  ["WSTRING", "CONCAT(DELETE(wc, 1, 1), wc)", "Ω"],
])("widens character inputs and executes %s := %s", (type, expression, expected) => {
  const { runtime, value } = execute(
    String(type),
    String(expression),
    `ch : CHAR := 'A'; wc : WCHAR := "Ω"; text : STRING := 'AB'; wide : WSTRING := "ΩB";`,
  );
  expect(runtime.diagnostic).toBeNull();
  expect(value).toMatchObject({
    kind: "scalar",
    dataType: String(type).split("[")[0],
    value: expected,
  });
});

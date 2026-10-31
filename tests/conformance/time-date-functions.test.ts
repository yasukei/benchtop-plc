import { expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import { formatValue } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

const program = (declarations: string, body: string) =>
  compile(`PROGRAM P\nVAR ${declarations} END_VAR\n${body}\nEND_PROGRAM`);
function execute(declarations: string, body: string) {
  const compiled = program(declarations, body);
  expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const ir = compiled.ir!;
  expect(JSON.parse(JSON.stringify(ir))).toEqual(ir);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  const snapshot = runtime.step();
  expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  const values = Object.fromEntries(
    snapshot.variables.map((cell, i) => [
      ir.variables[i]!.name.replace(/^mainInstance\./, ""),
      cell.kind === "scalar" ? cell.value : null,
    ]),
  );
  return { ir, runtime, snapshot, values };
}

it.each([
  ["TIME", "ADD_TIME(T#2147483647ms, T#1ms)", "T#-24d20h31m23s648ms"],
  ["TIME", "SUB_TIME(T#-2147483648ms, T#1ms)", "T#24d20h31m23s647ms"],
  ["TOD", "ADD_TOD_TIME(TOD#23:00:00, T#2h)", "TOD#01:00:00"],
  ["TOD", "SUB_TOD_TIME(TOD#01:00:00, T#2h)", "TOD#23:00:00"],
  ["DT", "ADD_DT_TIME(DT#2024-02-28-23:59:59, T#1s)", "DT#2024-02-29-00:00:00"],
  ["DT", "SUB_DT_TIME(DT#2024-03-01-00:00:00, T#1ms)", "DT#2024-02-29-23:59:59"],
  ["TIME", "SUB_DATE_DATE(D#2024-03-01, D#2024-02-28)", "T#2d"],
  ["TIME", "SUB_TOD_TOD(TOD#01:00:00, TOD#23:00:00)", "T#-22h"],
  ["TIME", "SUB_DT_DT(DT#2024-03-01-00:00:00, DT#2024-02-29-00:00:00)", "T#1d"],
  ["TIME", "MUL_TIME(T#3ms, 0.5)", "T#2ms"],
  ["TIME", "MUL_TIME(T#1ms, 0.5)", "T#0ms"],
  ["TIME", "MUL_TIME(T#-3ms, 0.5)", "T#-2ms"],
  ["TIME", "DIV_TIME(T#3ms, 2)", "T#1ms"],
  ["TIME", "DIV_TIME(T#3ms, 2.0)", "T#2ms"],
  ["TIME", "DIV_TIME(T#-3ms, 2)", "T#-1ms"],
  [
    "LTIME",
    "ADD_LTIME(LT#9223372036854775807ns, LT#1ns)",
    "LTIME#-106751d23h47m16s854ms775us808ns",
  ],
  [
    "LTIME",
    "SUB_LTIME(LT#-9223372036854775808ns, LT#1ns)",
    "LTIME#106751d23h47m16s854ms775us807ns",
  ],
  ["LTOD", "ADD_LTOD_LTIME(LTOD#23:59:59.999999999, LT#2ns)", "LTOD#00:00:00.000000001"],
  ["LTOD", "SUB_LTOD_LTIME(LTOD#00:00:00, LT#1ns)", "LTOD#23:59:59.999999999"],
  ["LDT", "ADD_LDT_LTIME(LDT#1969-12-31-23:59:59.999999999, LT#1ns)", "LDT#1970-01-01-00:00:00"],
  ["LDT", "SUB_LDT_LTIME(LDT#1970-01-01-00:00:00, LT#1ns)", "LDT#1969-12-31-23:59:59.999999999"],
  ["LTIME", "SUB_LDATE_LDATE(LDATE#1970-01-02, LDATE#1969-12-31)", "LTIME#2d"],
  ["LTIME", "SUB_LTOD_LTOD(LTOD#00:00:00.000000002, LTOD#00:00:00.000000001)", "LTIME#1ns"],
  ["LTIME", "SUB_LDT_LDT(LDT#1970-01-01-00:00:00, LDT#1969-12-31-23:59:59.999999999)", "LTIME#1ns"],
  ["LTIME", "MUL_LTIME(LT#3ns, 0.5)", "LTIME#2ns"],
  ["LTIME", "DIV_LTIME(LT#3ns, 2)", "LTIME#1ns"],
  ["LTIME", "DIV_LTIME(LT#3ns, 2.0)", "LTIME#2ns"],
] as const)("evaluates %s %s", (type, expression, expected) => {
  const { values, runtime } = execute(`x: ${type};`, `x := ${expression};`);
  expect(runtime.diagnostic).toBeNull();
  expect(formatValue(type, values.x as number | string)).toBe(expected);
});

it.each([
  ["DT", "CONCAT_DATE_TOD(D#2026-10-20, TOD#12:00:00)", "DT#2026-10-20-12:00:00"],
  ["DT", "CONCAT_DATE_TOD(D#1970-01-01, TOD#00:00:00.999)", "DT#1970-01-01-00:00:00"],
  [
    "LDT",
    "CONCAT_DATE_LTOD(D#2026-10-20, LTOD#12:00:00.000000001)",
    "LDT#2026-10-20-12:00:00.000000001",
  ],
  [
    "LDT",
    "CONCAT_DATE_LTOD(LDATE#1969-12-31, LTOD#23:59:59.999999999)",
    "LDT#1969-12-31-23:59:59.999999999",
  ],
  ["DATE", "CONCAT_DATE(2024, 2, 29)", "D#2024-02-29"],
  ["DATE", "CONCAT_DATE(DAY := 29, YEAR := 2024, MONTH := 2)", "D#2024-02-29"],
  ["TOD", "CONCAT_TOD(23, 59, 59, 999)", "TOD#23:59:59.999"],
  ["LTOD", "CONCAT_LTOD(12, 30, 15, 123)", "LTOD#12:30:15.123"],
  ["DT", "CONCAT_DT(2024, 2, 29, 12, 30, 15, 999)", "DT#2024-02-29-12:30:15"],
  ["LDT", "CONCAT_LDT(1969, 12, 31, 23, 59, 59, 999)", "LDT#1969-12-31-23:59:59.999"],
] as const)("combines %s components: %s", (type, expression, expected) => {
  const { values, runtime } = execute(`x: ${type};`, `x := ${expression};`);
  expect(runtime.diagnostic).toBeNull();
  expect(formatValue(type, values.x as number | string)).toBe(expected);
});

it.each([
  ["D#2026-10-20", 2],
  ["D#1970-01-01", 4],
  ["D#2024-03-03", 0],
  ["LDATE#1969-12-31", 3],
] as const)("returns the weekday of %s", (literal, expected) => {
  expect(execute("x: INT;", `x := DAY_OF_WEEK(${literal});`).values.x).toBe(expected);
});

it("splits a leap date through INT outputs with implicit widening and a BOOL result", () => {
  const { values, runtime, snapshot } = execute(
    "y: INT; m: DINT; d: LINT; ok: BOOL;",
    `
    ok := SPLIT_DATE(IN := D#2024-02-29, YEAR => y, MONTH => m, DAY => d);
    ABS(-1);
  `,
  );
  expect(runtime.diagnostic).toBeNull();
  expect(values).toEqual({ y: 2024, m: 2, d: "29", ok: true });
  expect(snapshot.annotations).toBeDefined();
});
it.each([
  ["SPLIT_DATE", "LDATE#1969-12-31", [1969, 12, 31]],
  ["SPLIT_TOD", "TOD#23:59:59.999", [23, 59, 59, 999]],
  ["SPLIT_LTOD", "LTOD#23:59:59.123456789", [23, 59, 59, 123]],
  ["SPLIT_DT", "DT#2024-02-29-12:34:56", [2024, 2, 29, 12, 34, 56, 0]],
  ["SPLIT_LDT", "LDT#1969-12-31-23:59:59.999999999", [1969, 12, 31, 23, 59, 59, 999]],
] as const)("splits %s", (name, literal, expected) => {
  const fields =
    name === "SPLIT_DATE"
      ? ["YEAR", "MONTH", "DAY"]
      : name === "SPLIT_DT" || name === "SPLIT_LDT"
        ? ["YEAR", "MONTH", "DAY", "HOUR", "MINUTE", "SECOND", "MILLISECOND"]
        : ["HOUR", "MINUTE", "SECOND", "MILLISECOND"];
  const { values, runtime } = execute(
    fields.map((_, i) => `v${i}: INT;`).join(" "),
    `${name}(IN := ${literal}, ${fields
      .map((f, i) => `${f} => v${i}`)
      .reverse()
      .join(", ")});`,
  );
  expect(runtime.diagnostic).toBeNull();
  expect(Object.values(values)).toEqual(expected);
});
it("evaluates split inputs once, supports omitted outputs and assigns aliases in source order", () => {
  const { values } = execute(
    "x: INT; realDay: REAL;",
    `
    SPLIT_DATE(IN := CONCAT_DATE(2024, 2, 29), MONTH => x, YEAR => x, DAY => realDay);
    SPLIT_DATE(IN := D#1970-01-01);
  `,
  );
  expect(values).toEqual({ x: 2024, realDay: 29 });
});

it.each([
  ["DATE", "CONCAT_DATE(2026, 2, 30)"],
  ["DATE", "CONCAT_DATE(2100, 2, 29)"],
  ["DATE", "CONCAT_DATE(2026, 13, 1)"],
  ["DATE", "CONCAT_DATE(1969, 12, 31)"],
  ["DATE", "CONCAT_DATE(ULINT#18446744073709551615, 1, 1)"],
  ["TOD", "CONCAT_TOD(24, 0, 0, 0)"],
  ["TOD", "CONCAT_TOD(0, -1, 0, 0)"],
  ["LTOD", "CONCAT_LTOD(0, 0, 60, 0)"],
  ["LTOD", "CONCAT_LTOD(0, 0, 0, 1000)"],
  ["DT", "CONCAT_DT(2106, 2, 7, 6, 28, 16, 0)"],
  ["LDT", "CONCAT_LDT(2262, 4, 12, 0, 0, 0, 0)"],
  ["DT", "CONCAT_DATE_TOD(D#2106-02-07, TOD#07:00:00)"],
  ["LDT", "CONCAT_DATE_LTOD(LDATE#2262-04-11, LTOD#23:59:59)"],
  ["DT", "ADD_DT_TIME(DT#2106-02-07-06:28:15, T#1s)"],
  ["DT", "SUB_DT_TIME(DT#1970-01-01-00:00:00, T#1ms)"],
  ["LDT", "ADD_LDT_LTIME(LDT#2262-04-11-23:47:16.854775807, LT#1ns)"],
  ["LDT", "SUB_LDT_LTIME(LDT#1677-09-21-00:12:43.145224192, LT#1ns)"],
] as const)("faults at the function span: %s %s", (type, expression) => {
  const { runtime } = execute(`x: ${type};`, `x := ${expression};`);
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.invalid-value",
    span: { line: 3, column: 6, endLine: 3, endColumn: 6 + expression.length },
  });
});
it.each([
  "DIV_TIME(T#1s, 0)",
  "DIV_TIME(T#1s, 0.0)",
  "DIV_LTIME(LT#1ns, 0)",
  "DIV_LTIME(LT#1ns, -0.0)",
])("faults on a zero divisor: %s", (expression) => {
  const type = expression.startsWith("DIV_LTIME") ? "LTIME" : "TIME";
  expect(execute(`x: ${type};`, `x := ${expression};`).runtime.diagnostic?.code).toBe(
    "runtime.division-by-zero",
  );
});

it.each([
  "SPLIT_DATE(IN := D#2024-02-29, YEAR => small);",
  "SPLIT_DATE(IN := D#2024-02-29, YEAR => unsigned);",
  "SPLIT_DATE(IN := D#2024-02-29, YEAR => timer.Q);",
  "SPLIT_DATE(IN := D#2024-02-29, YEAR => bits.0);",
  "SPLIT_DATE(IN := D#2024-02-29, YEAR => missing);",
  "SPLIT_DATE(IN := D#2024-02-29, YEAR => timer);",
  "SPLIT_DATE(IN := D#2024-02-29, YEAR => x, YEAR => x);",
  "SPLIT_DATE(IN := D#2024-02-29, UNKNOWN => x);",
  "SPLIT_DATE(IN => x);",
  "SPLIT_DATE(IN := D#2024-02-29, YEAR := 2024);",
  "SPLIT_DATE(IN := D#2024-02-29, IN := D#2024-02-29);",
  "SPLIT_DATE(YEAR => x);",
  "SPLIT_DATE(IN := TOD#00:00:00, YEAR => x);",
  "CONCAT_DATE(2024, 2.0, 29);",
  "CONCAT_DATE(YEAR := 2024, DAY := 29);",
  "ADD_TIME(LT#1ns, T#1ms);",
  "ADD_DT_TIME(D#2024-01-01, T#1s);",
  "MUL_TIME(T#1ms, TRUE);",
  "ABS(Unknown := 1);",
])("rejects invalid function arguments and output targets: %s", (body) => {
  const result = program(
    "x: INT; small: SINT; unsigned: UINT; timer: TON; bits: WORD; yes: BOOL;",
    body,
  );
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
});
it("keeps named calendar functions out of constant initializers", () => {
  expect(program("x: DATE := CONCAT_DATE(2024, 2, 29);", "").diagnostics).toContainEqual(
    expect.objectContaining({ code: "decl.nonconstant-initializer" }),
  );
});
it("widens fixed long inputs without changing the independent scaling factor", () => {
  const { values, runtime } = execute("x: LTIME;", "x := DIV_LTIME(T#3ms, LREAL#2.0);");
  expect(runtime.diagnostic).toBeNull();
  expect(values.x).toBe("1500000");
});

it("retains positional comparison expressions as function arguments", () => {
  expect(execute("x: INT := 1; y: DINT;", "y := SEL(x = 1, 10, 20);").values.y).toBe(20);
});

it.each([
  ["x: INT;", "SPLIT_DATE(YEAR => x);", "SPLIT_DATE", 1, 0],
  ["x: DATE;", "x := CONCAT_DATE(YEAR := 2024, MONTH := 2);", "CONCAT_DATE", 3, 2],
  ["x: DATE;", "x := CONCAT_DATE(2024, 2);", "CONCAT_DATE", 3, 2],
] as const)(
  "reports one arity error for an incomplete call: %s %s",
  (declarations, body, name, min, found) => {
    const result = program(declarations, body);
    const column = body.indexOf(name) + 1;
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toEqual([
      {
        code: "call.argument-count",
        severity: "error",
        pou: "P",
        args: { name, min, max: min, found },
        span: { line: 3, column, endLine: 3, endColumn: body.length },
      },
    ]);
  },
);

it.each(["timer(TRUE);"])("explains unsupported FB statement syntax: %s", (body) => {
  const result = program("timer: TON; yes: BOOL;", body);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toEqual([
    {
      code: "fb.unsupported-call",
      severity: "error",
      pou: "P",
      args: { name: "timer" },
      span: { line: 3, column: 1, endLine: 3, endColumn: body.length },
    },
  ]);
});

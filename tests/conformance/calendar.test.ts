import { expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import { scalarBase, formatValue, type CalendarType, type TypedValue } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

const program = (declarations: string, body = "") =>
  compile(`PROGRAM P VAR ${declarations} END_VAR ${body} END_PROGRAM`);
function execute(declarations: string, body = "") {
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
  return { ir, runtime, values };
}
it.each([
  ["DATE", "D#2024-02-29", "D#2024-02-29"],
  ["DATE", "DATE#2106-02-07", "D#2106-02-07"],
  ["LDATE", "LD#1677-09-22", "LDATE#1677-09-22"],
  ["LDATE", "LDATE#2262-04-11", "LDATE#2262-04-11"],
  ["TIME_OF_DAY", "TIME_OF_DAY#12:30:15.5", "TOD#12:30:15.5"],
  ["TOD", "TOD#23:59:59.999", "TOD#23:59:59.999"],
  ["LTIME_OF_DAY", "LTIME_OF_DAY#23:59:59.999999999", "LTOD#23:59:59.999999999"],
  ["LTOD", "LTOD#00:00:00.000000001", "LTOD#00:00:00.000000001"],
  ["DATE_AND_TIME", "DATE_AND_TIME#2106-02-07-06:28:15", "DT#2106-02-07-06:28:15"],
  ["DT", "DT#1970-01-01-00:00:00", "DT#1970-01-01-00:00:00"],
  [
    "LDATE_AND_TIME",
    "LDATE_AND_TIME#1677-09-21-00:12:43.145224192",
    "LDT#1677-09-21-00:12:43.145224192",
  ],
  ["LDT", "LDT#2262-04-11-23:47:16.854775807", "LDT#2262-04-11-23:47:16.854775807"],
])("parses and formats %s %s", (type, literal, expected) => {
  const { ir, values } = execute(`x: ${type} := ${literal};`);
  const variable = ir.variables[0]!;
  if (variable.kind !== "scalar") throw new Error("Expected scalar");
  expect(formatValue(scalarBase(variable.dataType, ir.types), values.x!)).toBe(expected);
});
it.each([
  ["DATE", "D#2023-02-29"],
  ["DATE", "D#2026-02-30"],
  ["DATE", "D#1900-01-01"],
  ["DATE", "D#2106-02-08"],
  ["DATE", "D#2026-13-01"],
  ["DATE", "D#2026-00-01"],
  ["LDATE", "LD#1677-09-21"],
  ["LDATE", "LD#2262-04-12"],
  ["TOD", "TOD#24:00:00"],
  ["TOD", "TOD#00:60:00"],
  ["TOD", "TOD#00:00:60"],
  ["TOD", "TOD#00:00:00.0001"],
  ["LTOD", "LTOD#00:00:00.0000000001"],
  ["DT", "DT#2106-02-07-06:28:16"],
  ["DT", "DT#1969-12-31-23:59:59"],
  ["DT", "DT#2026-01-01-00:00:00.1"],
  ["LDT", "LDT#1677-09-21-00:12:43.145224191"],
  ["LDT", "LDT#2262-04-11-23:47:16.854775808"],
])("rejects invalid %s literal %s", (type, literal) => {
  expect(program(`x: ${type} := ${literal};`).diagnostics).toContainEqual(
    expect.objectContaining({ code: "type.invalid-constant" }),
  );
});
it("supplies epoch and midnight defaults", () => {
  expect(
    execute("d: DATE; t: TOD; dtValue: DT; ldValue: LDATE; ltValue: LTOD; ldtValue: LDT;").values,
  ).toEqual({ d: 0, t: 0, dtValue: 0, ldValue: "0", ltValue: "0", ldtValue: "0" });
});
const arithmetic = [
  ["TOD", "TOD#23:00:00", "+", "TIME", "T#2h", "TOD", "TOD#01:00:00"],
  ["TOD", "TOD#00:00:01", "-", "TIME", "T#2s", "TOD", "TOD#23:59:59"],
  ["DT", "DT#2026-10-20-12:00:00", "-", "DT", "DT#2026-10-20-11:00:00", "TIME", "T#1h"],
  [
    "DT",
    "DT#2026-02-01-00:00:00",
    "-",
    "DT",
    "DT#2026-01-01-00:00:00",
    "TIME",
    "T#-18d17h2m47s296ms",
  ],
  ["DATE", "D#2026-02-01", "-", "DATE", "D#2026-01-01", "TIME", "T#-18d17h2m47s296ms"],
  ["TOD", "TOD#00:00:00", "-", "TOD", "TOD#00:00:00.001", "TIME", "T#-1ms"],
  ["DT", "DT#2026-10-20-12:00:00", "+", "TIME", "T#500ms", "DT", "DT#2026-10-20-12:00:00"],
  ["DT", "DT#2026-10-20-12:00:00", "-", "TIME", "T#500ms", "DT", "DT#2026-10-20-11:59:59"],
  ["LTOD", "LTOD#00:00:00", "-", "LTIME", "LT#1ns", "LTOD", "LTOD#23:59:59.999999999"],
  ["TOD", "TOD#00:00:00", "+", "LTIME", "LT#1ns", "LTOD", "LTOD#00:00:00.000000001"],
  [
    "LDT",
    "LDT#1969-12-31-23:59:59.999999999",
    "+",
    "TIME",
    "T#1ms",
    "LDT",
    "LDT#1970-01-01-00:00:00.000999999",
  ],
  [
    "LDATE",
    "LD#2262-04-11",
    "-",
    "LDATE",
    "LD#1677-09-22",
    "LTIME",
    "LTIME#-1d23h34m33s709ms551us616ns",
  ],
  ["DATE", "D#1970-01-02", "-", "LDATE", "LD#1970-01-01", "LTIME", "LTIME#1d"],
] as const;
it.each(arithmetic)("evaluates %s %s %s %s %s", (leftType, a, op, rightType, b, to, expected) => {
  const { values } = execute(
    `a: ${leftType} := ${a}; b: ${rightType} := ${b}; folded: ${to} := ${a}${op}${b}; result: ${to};`,
    `result := a ${op} b;`,
  );
  expect(formatValue(to, values.result as number | string)).toBe(expected);
  expect(values.folded).toBe(values.result);
});
const conversions = [
  ["DT", "DT#2026-10-20-12:30:15", "DATE", "D#2026-10-20"],
  ["DT", "DT#2026-10-20-12:30:15", "TOD", "TOD#12:30:15"],
  ["DT", "DT#2026-10-20-12:30:15", "LTOD", "LTOD#12:30:15"],
  ["DT", "DT#2026-10-20-12:30:15", "LDT", "LDT#2026-10-20-12:30:15"],
  ["LDT", "LDT#1970-01-01-00:00:01.999", "DT", "DT#1970-01-01-00:00:01"],
  ["LDT", "LDT#2026-10-20-12:30:15.123456789", "DATE", "D#2026-10-20"],
  ["LDT", "LDT#1969-12-31-23:59:59.999999999", "TOD", "TOD#23:59:59.999"],
  ["LDT", "LDT#1969-12-31-23:59:59.999999999", "LTOD", "LTOD#23:59:59.999999999"],
  ["TOD", "TOD#12:30:15.123", "LTOD", "LTOD#12:30:15.123"],
  ["LTOD", "LTOD#12:30:15.123456789", "TOD", "TOD#12:30:15.123"],
  ["DATE", "D#2024-02-29", "LDATE", "LDATE#2024-02-29"],
  ["LDATE", "LD#2024-02-29", "DATE", "D#2024-02-29"],
  ["LDT", "LDT#1969-12-31-23:59:59.999999999", "LDATE", "LDATE#1969-12-31"],
] as const;
it.each(conversions)("converts %s %s to %s", (from, literal, to, expected) => {
  const fn = `${from}_TO_${to}`;
  const { values } = execute(
    `source: ${from} := ${literal}; folded: ${to} := ${fn}(${literal}); result: ${to}; overloaded: ${to};`,
    `result := ${fn}(source); overloaded := TO_${to}(source);`,
  );
  expect(values.result).toBe(values.folded);
  expect(values.overloaded).toBe(values.result);
  expect(formatValue(to, values.result as number | string)).toBe(expected);
});
it.each([
  ["DT", "DT#2106-02-07-06:28:15", "TIME", "T#1s", "a + b"],
  ["DT", "DT#1970-01-01-00:00:00", "TIME", "T#1ms", "a - b"],
  ["LDT", "LDT#2262-04-11-23:47:16.854775807", "LTIME", "LT#1ns", "a + b"],
  ["LDATE", "LD#1969-12-31", "TIME", "T#0s", "LDATE_TO_DATE(a)"],
  ["LDT", "LDT#1969-12-31-23:59:59.999999999", "TIME", "T#0s", "LDT_TO_DT(a)"],
  ["LDT", "LDT#1677-09-21-00:12:43.145224192", "TIME", "T#0s", "LDT_TO_LDATE(a)"],
])("faults for a calendar result out of range: %s %s", (from, a, right, b, expr) => {
  const to = expr.includes("TO_DATE")
    ? "DATE"
    : expr.includes("TO_DT")
      ? "DT"
      : expr.includes("TO_LDATE")
        ? "LDATE"
        : from;
  expect(
    execute(`a: ${from} := ${a}; b: ${right} := ${b}; result: ${to};`, `result := ${expr};`).runtime
      .diagnostic?.code,
  ).toBe("runtime.invalid-value");
  expect(
    program(`result: ${to} := ${expr.replaceAll(/\ba\b/g, a).replaceAll(/\bb\b/g, b)};`)
      .diagnostics,
  ).toContainEqual(expect.objectContaining({ code: "type.invalid-constant" }));
});
it("widens assignments, initializers, selections, fixed conversion inputs and comparisons", () => {
  const { values } = execute(
    `d: DATE := D#2024-02-29; ldValue: LDATE := D#2024-02-29;
    t: TOD := TOD#12:00:00; ltValue: LTOD := TOD#12:00:00; dtValue: DT := DT#2024-02-29-12:00:00;
    ldtValue: LDT := DT#2024-02-29-12:00:00; yes: BOOL; selected: LDT; converted: LTOD;`,
    `ldValue := d; ltValue := t; ldtValue := dtValue; yes := d = ldValue AND t <= ltValue AND dtValue >= ldtValue AND dtValue <> LDT#2024-03-01-00:00:00;
     selected := SEL(TRUE, dtValue, ldtValue); converted := LDT_TO_LTOD(dtValue);`,
  );
  expect(values.yes).toBe(true);
  expect(values.selected).toBe(values.ldtValue);
  expect(values.converted).toBe("43200000000000");
});
it.each(["DATE", "TOD", "DT", "LDATE", "LTOD", "LDT"] as const)(
  "rejects invalid external %s values",
  (type) => {
    const { ir, runtime } = execute(`x: ${type};`);
    const invalid =
      type === "DATE"
        ? [1, -1, 4294967296]
        : type === "TOD"
          ? [86400000, -1, 1.1]
          : type === "DT"
            ? [-1, 4294967296, 0.1]
            : type === "LDATE"
              ? ["1", "-1", "9223372036854775808"]
              : type === "LTOD"
                ? ["86400000000000", "-1", "9223372036854775807"]
                : ["9223372036854775808", "-9223372036854775809"];
    const bad: unknown[] = [...invalid, "0x10", "-0", "+1", " 0", "00", NaN];
    for (const value of bad) {
      const corrupted = structuredClone(ir);
      Object.assign(corrupted.variables[0]!, { initialValue: value });
      expect(() => runtime.load(corrupted)).toThrow(RangeError);
      for (const method of ["write", "force"] as const)
        expect(() => runtime[method](0, { dataType: type, value } as TypedValue)).toThrow(
          "runtime.debug-value",
        );
    }
  },
);
it.each(["DATE", "TOD", "DT", "LDATE", "LTOD", "LDT"] as CalendarType[])(
  "supports overloaded %s identity",
  (type) => {
    expect(execute(`a: ${type}; b: ${type};`, `b := TO_${type}(a);`).values.a).toBe(
      execute(`a: ${type}; b: ${type};`, `b := TO_${type}(a);`).values.b,
    );
  },
);

it.each([
  "a := -a;",
  "a := a + a;",
  "t := a + T#1s;",
  "t := T#1s + t;",
  "yes := a = t;",
  "yes := t < stamp;",
  "a := 0;",
  "longDay := 0;",
  "t := ltValue;",
  "stamp := longStamp;",
  "longDay := stamp;",
  "t := TO_TOD(a);",
])("rejects calendar operations outside the supported signatures: %s", (body) => {
  expect(
    program(
      "a: DATE; longDay: LDATE; t: TOD; ltValue: LTOD; stamp: DT; longStamp: LDT; yes: BOOL;",
      body,
    ).ir,
  ).toBeUndefined();
});
it("applies Gregorian century leap-year rules", () => {
  expect(execute("a: DATE := D#2000-02-29;").values.a).toBe(951782400);
  expect(program("a: DATE := D#2100-02-29;").diagnostics).toContainEqual(
    expect.objectContaining({ code: "type.invalid-constant" }),
  );
});
it.each(["DATE", "TOD", "DT"] as const)(
  "validates %s literal payloads even in unexecuted IR",
  (type) => {
    const literal =
      type === "DATE" ? "D#1970-01-01" : type === "TOD" ? "TOD#00:00:00" : "DT#1970-01-01-00:00:00";
    const { runtime, ir } = execute(`x: ${type};`, `IF FALSE THEN x := ${literal}; END_IF;`);
    const conditional = ir.programs[0]!.body[0]!;
    if (conditional.kind !== "if") throw new Error("Expected IF");
    const assignment = conditional.branches[0].body[0]!;
    if (assignment.kind !== "assignment" || assignment.value.kind !== "literal")
      throw new Error("Expected literal assignment");
    Object.assign(assignment.value, {
      value: type === "DATE" ? 1 : type === "TOD" ? 86400000 : 4294967296,
    });
    expect(() => runtime.load(ir)).toThrow(RangeError);
  },
);

it.each(["LDT_TO_DATE(INT#1)", "LDATE_TO_DATE(TOD#00:00:01)", "LDT_TO_DT(TRUE)", "TO_DATE(INT#1)"])(
  "reports an invalid calendar conversion argument without crashing: %s",
  (call) => {
    const result = program("a: DATE;", `a := ${call};`);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ code: "call.argument-type" }),
    );
  },
);

it.each([
  ["DATE", "D#2026-1-5", "D#2026-01-05"],
  ["DATE", "DATE#2_026-01-0_5", "D#2026-01-05"],
  ["LDATE", "LD#1_677-9-22", "LDATE#1677-09-22"],
  ["TOD", "TOD#8:05:00", "TOD#08:05:00"],
  ["TOD", "TIME_OF_DAY#8:5:0.1_20", "TOD#08:05:00.12"],
  ["LTOD", "LTOD#15:36:55.360_227_400", "LTOD#15:36:55.3602274"],
  ["DT", "DT#2_026-1-5-8:5:0", "DT#2026-01-05-08:05:00"],
  ["LDT", "LDATE_AND_TIME#1_969-12-31-23:59:59.999_999_999", "LDT#1969-12-31-23:59:59.999999999"],
] as const)("accepts unpadded and separated calendar fields: %s %s", (type, literal, expected) => {
  const { values } = execute(`x: ${type} := ${literal};`);
  expect(formatValue(type, values.x as number | string)).toBe(expected);
});

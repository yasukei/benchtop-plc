import { describe, expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import { formatValue, type TypedValue, type ProgramIR } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function program(declarations: string, body = "") {
  return compile(`PROGRAM P VAR ${declarations} END_VAR ${body} END_PROGRAM`);
}
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
      ir.variables[i]!.name,
      cell.kind === "scalar" ? cell.value : null,
    ]),
  );
  return { values, ir, runtime, snapshot };
}

describe("64-bit values and arithmetic", () => {
  it("preserves all four types, boundaries, defaults and JSON transport", () => {
    const { values } = execute(`lo: LINT := -9223372036854775808;
      hi: LINT := 9223372036854775807; u: ULINT := 18446744073709551615;
      w: LWORD := LWORD#16#FFFFFFFFFFFFFFFF;
      t: LTIME := LT#-106751d23h47m16s854ms775us808ns;
      zero: LINT; uzero: ULINT; wz: LWORD; tz: LTIME;`);
    expect(values).toEqual({
      lo: "-9223372036854775808",
      hi: "9223372036854775807",
      u: "18446744073709551615",
      w: "18446744073709551615",
      t: "-9223372036854775808",
      zero: "0",
      uzero: "0",
      wz: "0",
      tz: "0",
    });
  });
  it.each([
    ["LINT", "9223372036854775808"],
    ["LINT", "-9223372036854775809"],
    ["ULINT", "18446744073709551616"],
    ["ULINT", "-1"],
    ["LWORD", "16#10000000000000000"],
    ["LTIME", "LT#106751d23h47m16s854ms775us808ns"],
    ["LTIME", "LT#0.1ns"],
  ])("rejects out-of-range %s constant %s", (type, literal) => {
    expect(program(`x: ${type} := ${literal};`).diagnostics).toContainEqual(
      expect.objectContaining({ code: "type.invalid-constant" }),
    );
  });
  it("wraps typed constants and executed arithmetic exactly", () => {
    expect(
      execute(
        `x: LINT := 9223372036854775807; u: ULINT := 18446744073709551615;
      initial: LINT := LINT#9223372036854775807 + 1; product: ULINT; quotient: LINT;
      remainder: LINT; negated: LINT;`,
        `
      x := x + 1; u := u + 1;
      product := ULINT#18446744073709551615 * ULINT#18446744073709551615;
      quotient := LINT#-9223372036854775808 / -1;
      remainder := LINT#-7 MOD 2; negated := -x;`,
      ).values,
    ).toEqual({
      x: "-9223372036854775808",
      u: "0",
      initial: "-9223372036854775808",
      product: "1",
      quotient: "-9223372036854775808",
      remainder: "-1",
      negated: "-9223372036854775808",
    });
  });
  it("uses LINT for DINT/UDINT products, comparisons and generic calls", () => {
    expect(
      execute(
        `d: DINT := 2147483647; u: UDINT := 4294967295; product: LINT;
      folded: LINT := DINT#2147483647 * UDINT#4294967295;
      larger: LINT; equal: BOOL;`,
        `product := d * u; larger := MAX(d, u);
      equal := product = folded;`,
      ).values,
    ).toMatchObject({
      product: "9223372030412324865",
      folded: "9223372030412324865",
      larger: "4294967295",
      equal: true,
    });
  });
  it("defaults independent large constants to LINT and requires explicit real conversions", () => {
    const { ir } = execute("x: INT;", "x := TO_INT(9007199254740993);");
    expect(ir.body[0]).toMatchObject({
      value: { args: [{ dataType: "LINT", value: "9007199254740993" }] },
    });
    for (const body of ["r := x;", "r := x + 1.0;", "x := x + u;", "u := -u;"])
      expect(program("x: LINT; u: ULINT; r: LREAL;", body).ir).toBeUndefined();
  });
  it("runs LINT FOR loops, CASE ranges and generic functions beyond 2^53", () => {
    expect(
      execute(
        `i: LINT; total: LINT; selected: LINT; yes: BOOL;`,
        `
      FOR i := 9007199254740993 TO 9007199254740995 DO total := total + 1; END_FOR;
      FOR i := 9007199254740995 TO 9007199254740993 BY -1 DO total := total + 1; END_FOR;
      CASE i OF 9007199254740992: yes := TRUE; ELSE yes := FALSE; END_CASE;
      selected := LIMIT(LINT#9007199254740993, LINT#9007199254740994, LINT#9007199254740995);
      selected := MIN(MAX(selected, LINT#9007199254740993), LINT#9007199254740994);`,
      ).values,
    ).toMatchObject({ total: "6", yes: true, selected: "9007199254740994" });
  });
  it("reads, writes and compares all 64 LWORD bits", () => {
    expect(
      execute(
        `w: LWORD := LWORD#16#FFFFFFFFFFFFFFFF; high: BOOL; less: BOOL;
      inverse: LWORD; mixed: LWORD;`,
        `w.63 := FALSE; w.0 := FALSE; w.62 := TRUE;
      high := w.62; less := w < LWORD#16#8000000000000000;
      inverse := NOT w; mixed := DWORD#16#FFFFFFFF OR LWORD#16#8000000000000000;`,
      ).values,
    ).toEqual({
      w: "9223372036854775806",
      high: true,
      less: true,
      inverse: "9223372036854775809",
      mixed: "9223372041149743103",
    });
    expect(program("w: LWORD;", "w.64 := TRUE;").diagnostics).toContainEqual(
      expect.objectContaining({ code: "type.invalid-bit-access" }),
    );
    expect(formatValue("LWORD", "1")).toBe("16#0000000000000001");
  });
  it.each(["LINT", "ULINT"])("faults on %s division by zero but not MOD zero", (type) => {
    const { runtime } = execute(`x: ${type} := 1; zero: ${type};`, "x := x / zero;");
    expect(runtime.diagnostic?.code).toBe("runtime.division-by-zero");
    expect(execute(`x: ${type} := 1;`, "x := x MOD 0;").values.x).toBe("0");
  });
});

describe("LTIME exact nanosecond durations", () => {
  it("supports sub-millisecond units, mixed TIME, widening and formatting", () => {
    const { values } = execute(
      `t: LTIME := LT#1ms + LT#500us; fromTime: LTIME := T#1ms;
      short: TIME := T#2ms; selected: LTIME; folded: LTIME := T#1ms + LT#500us;`,
      "t := short + t; fromTime := short; selected := SEL(TRUE, short, t);",
    );
    expect(values).toEqual({
      t: "3500000",
      fromTime: "2000000",
      short: 2,
      selected: "3500000",
      folded: "1500000",
    });
    expect(formatValue("LTIME", "1500000")).toBe("LTIME#1ms500us");
    expect(formatValue("LTIME", "-86400000000001")).toBe("LTIME#-1d1ns");
  });
  it.each([
    ["*", "9007199254740993", "0.5", "4503599627370496"],
    ["*", "9007199254740995", "0.5", "4503599627370498"],
    ["/", "9007199254740995", "2.0", "4503599627370498"],
    ["*", "-9007199254740995", "0.5", "-4503599627370498"],
    ["/", "3", "2", "1"],
    ["/", "-3", "2", "-1"],
    ["*", "9223372036854775807", "2", "-2"],
  ])("scales %s %s by %s once", (op, ns, factor, expected) => {
    expect(
      execute(
        `t: LTIME := LT#${ns}ns;
      folded: LTIME := LT#${ns}ns ${op} ${factor};`,
        `t := t ${op} ${factor};`,
      ).values,
    ).toEqual({ t: expected, folded: expected });
  });
});

const conversions = [
  ["LINT_TO_ULINT", "LINT", "-1", "ULINT", "18446744073709551615"],
  ["ULINT_TO_LINT", "ULINT", "18446744073709551615", "LINT", "-1"],
  ["LINT_TO_INT", "LINT", "9223372036854775807", "INT", -1],
  ["INT_TO_LWORD", "INT", "-1", "LWORD", "65535"],
  ["LINT_TO_LWORD", "LINT", "-1", "LWORD", "18446744073709551615"],
  ["LWORD_TO_LINT", "LWORD", "16#FFFFFFFFFFFFFFFF", "LINT", "-1"],
  ["LWORD_TO_DWORD", "LWORD", "16#FEDCBA9876543210", "DWORD", 1985229328],
  ["LWORD_TO_BOOL", "LWORD", "16#8000000000000000", "BOOL", false],
  ["LREAL_TO_LWORD", "LREAL", "1.0", "LWORD", "4607182418800017408"],
  ["LWORD_TO_LREAL", "LWORD", "16#3FF0000000000000", "LREAL", 1],
  ["LWORD_TO_LREAL", "LWORD", "16#8000000000000000", "LREAL", 0],
  ["LINT_TO_LREAL", "LINT", "9007199254740993", "LREAL", 9007199254740992],
  ["LINT_TO_LREAL", "LINT", "9007199254740995", "LREAL", 9007199254740996],
  ["LINT_TO_REAL", "LINT", "4611686293305294849", "REAL", 4611686568183201792],
  ["LREAL_TO_LINT", "LREAL", "2.5", "LINT", "2"],
  ["LREAL_TO_ULINT", "LREAL", "-3.5", "ULINT", "18446744073709551612"],
  ["LREAL_TO_LINT", "LREAL", "9223372036854775808.0", "LINT", "-9223372036854775808"],
  ["LTIME_TO_TIME", "LTIME", "LTIME#-1500us", "TIME", -1],
  ["TIME_TO_LTIME", "TIME", "T#-1ms", "LTIME", "-1000000"],
  ["LINT_TO_LTIME", "LINT", "9007199254740993", "LTIME", "9007199254740993"],
  ["LTIME_TO_LINT", "LTIME", "LT#9007199254740993ns", "LINT", "9007199254740993"],
  ["ULINT_TO_TIME", "ULINT", "18446744073709551615", "TIME", -1],
  ["TIME_TO_ULINT", "TIME", "T#-1ms", "ULINT", "18446744073709551615"],
] as const;
it.each(conversions)(
  "evaluates %s for constants, variables and overloaded forms",
  (fn, from, literal, to, expected) => {
    expect(
      execute(
        `source: ${from} := ${literal}; initial: ${to} := ${fn}(${literal});
    result: ${to}; overloaded: ${to};`,
        `result := ${fn}(source); overloaded := TO_${to}(source);`,
      ).values,
    ).toEqual({
      source: expect.anything(),
      initial: expected,
      result: expected,
      overloaded: expected,
    });
  },
);
it.each(["16#7FF0000000000000", "16#FFF0000000000000", "16#7FF8000000000000"])(
  "rejects nonfinite LREAL pattern %s",
  (pattern) => {
    expect(
      execute(`w: LWORD := ${pattern}; r: LREAL;`, "r := LWORD_TO_LREAL(w);").runtime.diagnostic
        ?.code,
    ).toBe("runtime.invalid-value");
    expect(program(`r: LREAL := LWORD_TO_LREAL(${pattern});`).diagnostics).toContainEqual(
      expect.objectContaining({ code: "type.invalid-constant" }),
    );
  },
);

it.each(["LINT", "ULINT", "LWORD", "LTIME"] as const)(
  "rejects malformed external %s strings without changing state",
  (type) => {
    const { runtime, ir } = execute(`x: ${type};`);
    const invalid: unknown[] = [
      " 12",
      "0x10",
      "-0",
      "+1",
      "01",
      "1 ",
      "",
      "1.0",
      "1e2",
      "18446744073709551616",
      1,
      1n,
    ];
    for (const value of invalid) {
      const initial: ProgramIR = structuredClone(ir);
      Object.assign(initial.variables[0]!, { initialValue: value });
      expect(() => runtime.load(initial)).toThrow(RangeError);
      for (const method of ["write", "force"] as const)
        expect(() => runtime[method](0, { dataType: type, value } as TypedValue)).toThrow(
          "runtime.debug-value",
        );
      expect(runtime.snapshot().variables[0]).toMatchObject({ value: "0" });
      expect(runtime.snapshot().forced).toEqual([]);
    }
    const max =
      type === "ULINT" || type === "LWORD" ? "18446744073709551615" : "9223372036854775807";
    runtime.write(0, { dataType: type, value: max });
    expect(runtime.snapshot().variables[0]).toMatchObject({ value: max });
    runtime.force(0, { dataType: type, value: "1" });
    expect(runtime.step().variables[0]).toMatchObject({ value: "1" });
  },
);
it("rejects a noncanonical literal even in an unexecuted IR branch", () => {
  const { ir, runtime } = execute("x: LINT;", "IF FALSE THEN x := LINT#1; END_IF;");
  const conditional = ir.body[0]!;
  if (conditional.kind !== "if") throw new Error("Expected IF");
  const assignment = conditional.branches[0].body[0]!;
  if (assignment.kind !== "assignment" || assignment.value.kind !== "literal")
    throw new Error("Expected literal assignment");
  Object.assign(assignment.value, { value: "0x10" });
  expect(() => runtime.load(ir)).toThrow(RangeError);
});

it("widens TIME arguments to a fixed LTIME conversion source", () => {
  expect(
    execute(
      `short: TIME := T#1ms; folded: LINT := LTIME_TO_LINT(T#1ms);
    result: LINT;`,
      "result := LTIME_TO_LINT(short);",
    ).values,
  ).toEqual({ short: 1, folded: "1000000", result: "1000000" });
});
it("preserves a large integer TIME factor and LTIME comparisons", () => {
  expect(
    execute(
      `short: TIME := T#1ms; factor: LINT := 9007199254740993;
    folded: TIME := T#1ms * LINT#9007199254740993;
    t: LTIME := LT#1000001ns; greater: BOOL;`,
      "short := short * factor; greater := t > T#1ms;",
    ).values,
  ).toEqual({ short: 1, factor: "9007199254740993", folded: 1, t: "1000001", greater: true });
});

it("accepts overloaded duration identity conversions", () => {
  expect(execute(`t: TIME := TO_TIME(T#1ms); lt: LTIME := TO_LTIME(LT#1ns);`).values).toEqual({
    t: 1,
    lt: "1",
  });
});
it("canonicalizes long CASE labels and rejects malformed label payloads", () => {
  const { ir, runtime } = execute(
    "x: LINT; yes: BOOL;",
    "CASE x OF INT#1..INT#2: yes := TRUE; 0: yes := TRUE; END_CASE;",
  );
  const statement = ir.body[0]!;
  if (statement.kind !== "case") throw new Error("Expected CASE");
  expect(statement.branches[0]!.labels[0]).toMatchObject({ lower: "1", upper: "2" });
  expect(statement.branches[1]!.labels[0]).toMatchObject({ value: "0" });
  for (const malformed of ["0x10", "+1", "-0", "9223372036854775808"]) {
    const corrupted = structuredClone(ir);
    const branch = corrupted.body[0]!;
    if (branch.kind !== "case") throw new Error("Expected CASE");
    Object.assign(branch.branches[0]!.labels[0]!, { lower: malformed });
    expect(() => runtime.load(corrupted)).toThrow(RangeError);
  }
});

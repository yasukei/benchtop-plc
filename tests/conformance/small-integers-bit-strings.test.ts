import { describe, expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import { formatValue, type DataType, type ScalarValue, type TypedValue } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function program(declarations: string, body = "") {
  return compile(`PROGRAM P VAR ${declarations} END_VAR ${body} END_PROGRAM`);
}
function execute(declarations: string, body = "") {
  const result = program(declarations, body);
  expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  expect(result.ir).toBeDefined();
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(JSON.parse(JSON.stringify(result.ir)));
  const snapshot = runtime.scanOnce();
  const values: Record<string, ScalarValue> = {};
  snapshot.variables.forEach((cell, index) => {
    if (cell.kind === "scalar") values[result.ir!.variables[index]!.name] = cell.value;
  });
  return { values, snapshot, runtime, ir: result.ir! };
}

const ranges = [
  ["SINT", -128, 127],
  ["USINT", 0, 255],
  ["UDINT", 0, 4294967295],
  ["BYTE", 0, 255],
  ["WORD", 0, 65535],
  ["DWORD", 0, 4294967295],
] as const;

describe("small integers and bit strings", () => {
  it.each(ranges)(
    "accepts the %s endpoints and rejects out-of-range constants",
    (type, min, max) => {
      expect(
        execute(`lo: ${type} := ${min}; hi: ${type} := ${type}#${max}; zero: ${type};`).values,
      ).toEqual({ lo: min, hi: max, zero: 0 });
      for (const literal of [String(min - 1), `${type}#${max + 1}`, `${max} + 1`])
        expect(program(`x: ${type} := ${literal};`).diagnostics).toContainEqual(
          expect.objectContaining({ code: "type.invalid-constant" }),
        );
    },
  );
  it.each([
    ["SINT", 127, -128, -128, 127],
    ["USINT", 255, 0, 0, 255],
    ["UDINT", 4294967295, 0, 0, 4294967295],
  ])("wraps %s arithmetic in initializers and execution", (type, max, next, min, previous) => {
    expect(
      execute(
        `a: ${type} := ${max}; b: ${type} := ${min}; c: ${type} := ${type}#${max} + ${type}#1;`,
        "a := a + 1; b := b - 1;",
      ).values,
    ).toEqual({ a: next, b: previous, c: next });
  });
  it("keeps the low 32 product bits without binary64 rounding loss", () => {
    expect(
      execute(
        `a: UDINT := 4294967295; result: UDINT;
      folded: UDINT := UDINT#4294967295 * UDINT#4294967295;`,
        "result := a * a;",
      ).values,
    ).toEqual({ a: 4294967295, result: 1, folded: 1 });
  });
  it("widens through integer, real and bit-string families", () => {
    expect(
      execute(
        `s: SINT := -128; u: USINT := 255; ui: UINT; ud: UDINT := 4294967295;
      i: INT; d: DINT; r: REAL; l: LREAL; b: BYTE; w: WORD; dw: DWORD; mixed: INT;`,
        `ui := u; i := u; d := s; r := u; l := ud; b := TRUE; w := b; dw := w;
       mixed := s + u;`,
      ).values,
    ).toMatchObject({
      ui: 255,
      i: 255,
      d: -128,
      r: 255,
      l: 4294967295,
      b: 1,
      w: 1,
      dw: 1,
      mixed: 127,
    });
  });
  it.each(["d + u", "u + d", "MAX(d, u)", "SEL(TRUE, d, u)"])(
    "rejects %s because its common type LINT is not implemented",
    (expression) => {
      const result = program("d: DINT; u: UDINT; out: LREAL;", `out := ${expression};`);
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics.some((item) => item.severity === "error")).toBe(true);
    },
  );
  it.each(["SINT", "USINT", "UDINT"])(
    "requires narrowing conversions and rejects unsigned unary minus for %s",
    (type) => {
      expect(program(`x: ${type}; d: LREAL;`, "x := d;").diagnostics).toContainEqual(
        expect.objectContaining({
          code: "type.assign-mismatch",
          args: expect.objectContaining({ hint: "explicit-conversion" }),
        }),
      );
      if (type !== "SINT") expect(program(`x: ${type};`, "x := -x;").ir).toBeUndefined();
    },
  );
  it("types constants from their small integer neighbors", () => {
    expect(program("u: USINT;", "u := MAX(1, u, 300);").diagnostics).toContainEqual(
      expect.objectContaining({ code: "type.invalid-constant" }),
    );
  });
  it("executes FOR with small and unsigned variables", () => {
    expect(
      execute(
        "s: SINT; u: USINT; d: UDINT; sum: INT;",
        `
      FOR s := -2 TO 0 DO sum := sum + s; END_FOR;
      FOR u := 1 TO 3 DO sum := sum + u; END_FOR;
      FOR d := 1 TO 2 DO EXIT; END_FOR;`,
      ).values,
    ).toMatchObject({ sum: 3, d: 1 });
  });
});

describe("bit-string operators and bit access", () => {
  it("uses the common bit type, unsigned results and numeric comparisons", () => {
    expect(
      execute(
        `b: BYTE := 16#0F; w: WORD := 16#FF00; d: DWORD := DWORD#16#FFFFFFFF;
      a: BYTE; o: WORD; x: DWORD; n: DWORD; equal: BOOL; less: BOOL; high: BOOL;`,
        `
      a := b AND 16#03; o := b OR w; x := d XOR w; n := NOT d;
      equal := TRUE = BYTE#1; less := BYTE#255 < WORD#256; high := d > DWORD#16#7FFFFFFF;
      b := TRUE AND b; w := w & 16#FF0F;`,
      ).values,
    ).toEqual({
      b: 1,
      w: 65280,
      d: 4294967295,
      a: 3,
      o: 65295,
      x: 4294902015,
      n: 0,
      equal: true,
      less: true,
      high: true,
    });
    expect(
      execute(`a: DWORD := TRUE OR DWORD#16#80000000;
      eq: BOOL := TRUE = BYTE#1; n: BYTE := NOT BYTE#0;`).values,
    ).toEqual({ a: 2147483649, eq: true, n: 255 });
  });
  it.each(["AND", "&", "OR", "XOR"])("rejects integer %s", (operator) => {
    expect(program("i: INT;", `i := i ${operator} 1;`).diagnostics).toContainEqual(
      expect.objectContaining({ code: "type.operand-mismatch" }),
    );
  });
  it("rejects integer NOT", () => {
    expect(program("i: INT;", "i := NOT i;").ir).toBeUndefined();
  });
  it("reads and writes the first and last bits without changing adjacent bits", () => {
    const result = execute(
      `b: BYTE := 16#AA; w: WORD; d: DWORD := DWORD#16#FFFFFFFF;
      read: BOOL; copied: BOOL;`,
      `
      b.0 := TRUE; b.7 := FALSE; w.15 := TRUE; d.31 := FALSE; d.0 := FALSE;
      read := w.15; copied := b.0; w.0 := d.30;`,
    );
    expect(result.values).toEqual({ b: 43, w: 32769, d: 2147483646, read: true, copied: true });
    expect(result.ir.body[2]).toMatchObject({ target: { kind: "bit", bit: 15, dataType: "BOOL" } });
    expect(execute("w: WORD;", "w.15 := TRUE;").values.w).toBe(32768);
    expect(execute("d: DWORD;", "d.31 := TRUE;").values.d).toBe(2147483648);
  });
  it.each([
    ["BYTE", 8],
    ["WORD", 16],
    ["DWORD", 32],
    ["INT", 0],
    ["BOOL", 0],
  ] as const)("rejects invalid bit %s.%s at compile time", (type, bit) => {
    expect(program(`x: ${type};`, `x.${bit} := TRUE;`).diagnostics).toContainEqual(
      expect.objectContaining({ code: "type.invalid-bit-access" }),
    );
  });
  it.each(["x.i", "x.-1", "x.1.5"])(
    "rejects nonconstant or malformed bit access %s",
    (expression) => {
      expect(program("x: WORD; i: INT; b: BOOL;", `b := ${expression};`).ir).toBeUndefined();
    },
  );
  it("rejects excessive bit indices with JSON-safe diagnostics", () => {
    const result = program("w: WORD;", `w.${"9".repeat(400)} := TRUE;`);
    expect(result.ir).toBeUndefined();
    expect(JSON.parse(JSON.stringify(result.diagnostics))).toEqual(result.diagnostics);
  });
  it("formats every bit-string width in uppercase hexadecimal", () => {
    expect(formatValue("BYTE", 1)).toBe("16#01");
    expect(formatValue("WORD", 255)).toBe("16#00FF");
    expect(formatValue("DWORD", 4294967295)).toBe("16#FFFFFFFF");
  });
});

const conversions = [
  ["SINT_TO_USINT", "-1", "SINT", -1, "USINT", 255],
  ["USINT_TO_SINT", "255", "USINT", 255, "SINT", -1],
  ["UDINT_TO_DINT", "4294967295", "UDINT", 4294967295, "DINT", -1],
  ["DINT_TO_UDINT", "-1", "DINT", -1, "UDINT", 4294967295],
  ["REAL_TO_SINT", "126.5", "REAL", 126.5, "SINT", 126],
  ["LREAL_TO_USINT", "255.5", "LREAL", 255.5, "USINT", 0],
  ["UDINT_TO_LREAL", "4294967295", "UDINT", 4294967295, "LREAL", 4294967295],
  ["BOOL_TO_UDINT", "TRUE", "BOOL", true, "UDINT", 1],
  ["BOOL_TO_BYTE", "TRUE", "BOOL", true, "BYTE", 1],
  ["BYTE_TO_BOOL", "2", "BYTE", 2, "BOOL", false],
  ["WORD_TO_BOOL", "3", "WORD", 3, "BOOL", true],
  ["DWORD_TO_BYTE", "16#FFFFFFFF", "DWORD", 4294967295, "BYTE", 255],
  ["BYTE_TO_DWORD", "16#FF", "BYTE", 255, "DWORD", 255],
  ["INT_TO_DWORD", "-1", "INT", -1, "DWORD", 65535],
  ["SINT_TO_WORD", "-1", "SINT", -1, "WORD", 255],
  ["DINT_TO_DWORD", "-1", "DINT", -1, "DWORD", 4294967295],
  ["WORD_TO_INT", "16#FFFF", "WORD", 65535, "INT", -1],
  ["BYTE_TO_INT", "16#FF", "BYTE", 255, "INT", 255],
  ["DWORD_TO_UDINT", "16#FFFFFFFF", "DWORD", 4294967295, "UDINT", 4294967295],
  ["REAL_TO_DWORD", "1.0", "REAL", 1, "DWORD", 1065353216],
  ["DWORD_TO_REAL", "16#3F800000", "DWORD", 1065353216, "REAL", 1],
  ["DWORD_TO_REAL", "16#80000000", "DWORD", 2147483648, "REAL", 0],
  ["TIME_TO_USINT", "T#256ms", "TIME", 256, "USINT", 0],
  ["UDINT_TO_TIME", "4294967295", "UDINT", 4294967295, "TIME", -1],
  ["SINT_TO_TIME", "-128", "SINT", -128, "TIME", -128],
] as const;

describe("conversion families", () => {
  it.each(conversions)(
    "%s uses the same semantics for constants, variables and TO_",
    (fn, literal, from, input, to, expected) => {
      const { values } = execute(
        `source: ${from} := ${literal}; initial: ${to} := ${fn}(${literal});
      result: ${to}; overloaded: ${to};`,
        `result := ${fn}(source); overloaded := TO_${to}(source);`,
      );
      expect(values).toEqual({
        source: input,
        initial: expected,
        result: expected,
        overloaded: expected,
      });
    },
  );
  it("zero-fills according to the declared conversion source after implicit widening", () => {
    expect(
      execute("s: SINT := -1; a: DWORD; b: DWORD;", "a := INT_TO_DWORD(s); b := TO_DWORD(s);")
        .values,
    ).toEqual({ s: -1, a: 65535, b: 255 });
  });
  it.each(["16#7FC00000", "16#7F800000", "16#FF800000"])(
    "faults on nonfinite REAL pattern %s",
    (pattern) => {
      const { runtime } = execute(
        `source: DWORD := ${pattern}; result: REAL;`,
        "result := DWORD_TO_REAL(source);",
      );
      expect(runtime.diagnostic?.code).toBe("runtime.invalid-value");
      expect(program(`result: REAL := DWORD_TO_REAL(${pattern});`).diagnostics).toContainEqual(
        expect.objectContaining({ code: "type.invalid-constant" }),
      );
    },
  );
  it.each([
    "REAL_TO_DWORD(1.0)",
    "DWORD_TO_REAL(16#3F800000)",
    "BYTE_TO_BOOL(2)",
    "TO_BOOL(BYTE#2)",
  ])("reports a nonblocking portability warning for %s", (expression) => {
    const type = expression.includes("TO_BOOL")
      ? "BOOL"
      : expression.startsWith("REAL")
        ? "DWORD"
        : "REAL";
    const result = program(`value: ${type};`, `value := ${expression};`);
    expect(result.ir).toBeDefined();
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "type.portability", severity: "warning" }),
    ]);
  });
  it.each([
    ["w: WORD; b: BOOL := WORD_TO_BOOL(w);"],
    ["r: REAL; d: DWORD := REAL_TO_DWORD(r);"],
    ["d: DWORD; r: REAL := DWORD_TO_REAL(d);"],
  ])("keeps nonconstant initializer errors alongside portability warnings: %s", (declarations) => {
    const result = program(declarations);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "type.portability", severity: "warning" }),
        expect.objectContaining({ code: "decl.nonconstant-initializer", severity: "error" }),
      ]),
    );
  });
  it.each([
    "TO_REAL(TRUE)",
    "TO_REAL(BYTE#1)",
    "TO_LREAL(WORD#1)",
    "TO_BOOL(INT#1)",
    "TO_TIME(BYTE#1)",
  ])("rejects unsupported overloaded source families: %s", (expression) => {
    expect(program("", `IF ${expression} = ${expression} THEN END_IF;`).ir).toBeUndefined();
  });
});

const externalRanges: readonly (readonly [DataType, number, number])[] = [
  ...ranges,
  ["INT", -32768, 32767],
  ["UINT", 0, 65535],
  ["DINT", -2147483648, 2147483647],
  ["TIME", -2147483648, 2147483647],
];
describe("runtime external value validation", () => {
  it.each(externalRanges)(
    "rejects invalid %s initial, write and force values without wrapping",
    (type, min, max) => {
      const { runtime, ir } = execute(`value: ${type};`);
      for (const value of [min - 1, max + 1, 0.5, -0, Infinity, NaN]) {
        const initial = structuredClone(ir);
        const variable = initial.variables[0]!;
        if (variable.kind === "scalar" && variable.dataType !== "BOOL")
          variable.initialValue = value;
        expect(() => runtime.load(initial)).toThrow(RangeError);
        for (const method of ["write", "force"] as const) {
          expect(() => runtime[method](0, { dataType: type, value } as TypedValue)).toThrow(
            "runtime.debug-value",
          );
          expect(runtime.snapshot().variables[0]).toMatchObject({ value: 0 });
          expect(runtime.snapshot().forced).toEqual([]);
        }
      }
      for (const value of [min, max]) {
        runtime.write(0, { dataType: type, value } as TypedValue);
        expect(runtime.snapshot().variables[0]).toMatchObject({ value });
        runtime.force(0, { dataType: type, value } as TypedValue);
        runtime.scanOnce();
        expect(runtime.snapshot().variables[0]).toMatchObject({ value });
        runtime.force(0, null);
      }
    },
  );
});

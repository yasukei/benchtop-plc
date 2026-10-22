import { expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

const program = (expression: string) =>
  `PROGRAM TimeTest\nVAR x : TIME := ${expression}; END_VAR\nEND_PROGRAM`;
function runtime() {
  const clock = new VirtualClock();
  return createRuntime({ clock, ticker: new VirtualTicker(clock) });
}

it.each([
  "T#24d20h31m23s648ms",
  "T#-24d20h31m23s649ms",
  "T#30d",
  "T#9007199254740993ms",
  `T#${"9".repeat(309)}ms`,
  "T#2147483647.0000000001ms",
  "T#-2147483648.0000000001ms",
])("rejects out-of-range literal %s at its span", (literal) => {
  const result = compile(program(literal));
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toEqual([
    {
      code: "type.invalid-constant",
      severity: "error",
      pou: "TimeTest",
      args: {},
      span: { line: 2, column: 17, endLine: 2, endColumn: 17 + literal.length },
    },
  ]);
});

it.each([
  ["T#24d20h31m23s647ms", 2147483647],
  ["T#2147483646.99999999999ms", 2147483646],
  ["T#-24d20h31m23s648ms", -2147483648],
  ["T#24d * 2", -147767296],
  ["T#1s * 1.0e100", 0],
  ["T#3ms * 0.5", 2],
  ["T#5ms * 0.5", 2],
  ["T#-7ms / 2", -3],
  ["T#-7ms / 2.0", -4],
  ["T#2147483647ms * 1000000001", 1147483647],
  ["T#2147483647ms + T#1ms", -2147483648],
  ["T#-2147483648ms - T#1ms", 2147483647],
  ["-T#-2147483648ms", -2147483648],
] as const)("matches constant and runtime results for %s", (expression, expected) => {
  const result = compile(
    `PROGRAM TimeTest VAR initial : TIME := ${expression}; actual : TIME; END_VAR actual := ${expression}; END_PROGRAM`,
  );
  expect(result.diagnostics).toEqual([]);
  const plc = runtime();
  plc.load(result.ir!);
  expect(plc.step().variables).toMatchObject([{ value: expected }, { value: expected }]);
  expect(plc.state).toBe("STOP");
});

it.each(["T#1s / 0", "T#1s / 0.0"])("rejects constant division by zero: %s", (expression) => {
  expect(compile(program(expression)).diagnostics.map((d) => d.code)).toContain(
    "type.invalid-constant",
  );
});

it("rejects invalid initial values, writes and forces atomically", () => {
  const ir = compile(program("T#1s")).ir!;
  const plc = runtime();
  plc.load(ir);
  plc.run();
  plc.write(0, { dataType: "TIME", value: 2147483647 });
  const before = plc.snapshot();
  for (const value of [2147483648, -2147483649, Infinity, NaN, 0.5, -0]) {
    for (const command of ["write", "force"] as const)
      expect(() => plc[command](0, { dataType: "TIME", value })).toThrow("runtime.debug-value");
    const invalid = structuredClone(ir);
    const variable = invalid.variables[0]!;
    if (variable.kind !== "scalar" || variable.dataType !== "TIME")
      throw new Error("Expected TIME");
    variable.initialValue = value;
    expect(() => plc.load(invalid)).toThrow(RangeError);
    expect(plc.snapshot()).toEqual(before);
    expect(plc.state).toBe("RUN");
  }
  plc.scanOnce();
  expect(plc.snapshot().variables[0]).toMatchObject({ value: 2147483647 });
  plc.force(0, { dataType: "TIME", value: -2147483648 });
  plc.scanOnce();
  expect(plc.snapshot().variables[0]).toMatchObject({ value: -2147483648 });
});

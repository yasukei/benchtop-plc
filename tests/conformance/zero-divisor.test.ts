import { expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

it.each([
  ["INT", "7"],
  ["DINT", "40000"],
  ["REAL", "1.0"],
  ["LREAL", "1.0"],
] as const)("keeps %s division by zero as a fault at the expression span", (type, dividend) => {
  const result = compile(
    `PROGRAM Division\nVAR r : ${type}; divisor : ${type}; END_VAR\nr := ${dividend} / divisor;\nEND_PROGRAM`,
  );
  expect(result.diagnostics).toEqual([]);
  const ir = result.ir!;
  const statement = ir.programs[0]!.body[0]!;
  if (statement.kind !== "assignment") throw new Error("Expected assignment");
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  runtime.run();
  clock.advance(10);
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toEqual({
    code: "runtime.division-by-zero",
    severity: "error",
    instance: "mainInstance",
    task: "Cyclic",
    pou: "Division",
    span: statement.value.span,
    args: {},
  });
});

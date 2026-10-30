import type { ProgramIR } from "@benchtop-plc/core";
import { expect, it } from "vitest";
import { createRuntime, VirtualClock, VirtualTicker } from "./index.js";

const span = { line: 1, column: 1, endLine: 1, endColumn: 10 };
const program: ProgramIR = {
  kind: "program",
  name: "Main",
  span,
  variables: [
    {
      kind: "scalar",
      name: "q",
      key: "Q",
      dataType: "BOOL",
      initialValue: false,
      span,
      address: { area: "Q", size: "X", byte: 0, bit: 0 },
    },
  ],
  body: [
    {
      kind: "assignment",
      span,
      target: { kind: "variable", variable: 0, dataType: "BOOL", span },
      value: { kind: "literal", dataType: "BOOL", value: true, span },
    },
  ],
};

it("latches a host failure, de-energizes outputs, cancels ticks and requires a restart", () => {
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(program);
  runtime.run();
  clock.advance(10);
  expect(runtime.snapshot().outputs[0]).toBe(1);
  runtime.fail();
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toEqual({
    code: "runtime.internal-error",
    severity: "error",
    args: {},
  });
  expect(runtime.snapshot().outputs.every((byte) => byte === 0)).toBe(true);
  runtime.stop();
  runtime.run();
  runtime.step();
  clock.advance(100);
  expect(runtime.state).toBe("FAULT");
  expect(runtime.snapshot().scanCount).toBe(1);
  runtime.warmRestart();
  expect(runtime.diagnostic).toBeNull();
  expect(runtime.state).toBe("STOP");
});

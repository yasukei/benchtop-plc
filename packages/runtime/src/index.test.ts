import { describe, expect, it } from "vitest";
import type { ProgramIR } from "@benchtop-plc/core";
import {
  callStandardFunction,
  createRuntime,
  createStandardFunctionBlock,
  RuntimeCommandRejected,
  standardLibrary,
  VirtualClock,
  VirtualTicker,
} from "./index.js";
import type { Runtime, RuntimeLibrary } from "./index.js";

const span = { line: 1, column: 1, endLine: 1, endColumn: 2 };
const program: ProgramIR = {
  kind: "program",
  name: "Counter",
  span,
  variables: [
    { kind: "scalar", name: "count", key: "COUNT", dataType: "INT", initialValue: 0, span },
  ],
  body: [
    {
      kind: "assignment",
      span,
      target: { kind: "variable", variable: 0, dataType: "INT", span },
      value: {
        kind: "binary",
        operator: "+",
        dataType: "INT",
        span,
        left: { kind: "variable", variable: 0, dataType: "INT", span },
        right: { kind: "literal", dataType: "INT", value: 1, span },
      },
    },
  ],
};

describe("@benchtop-plc/runtime public API", () => {
  it("executes typed IR using the exported virtual clock and ticker", () => {
    const clock = new VirtualClock();
    const runtime: Runtime = createRuntime({
      clock,
      ticker: new VirtualTicker(clock),
      intervalMs: 10,
    });
    runtime.load(program);
    expect(runtime.step().variables).toEqual([{ kind: "scalar", dataType: "INT", value: 1 }]);
    runtime.run();
    clock.advance(20);
    expect(runtime.snapshot().variables).toEqual([{ kind: "scalar", dataType: "INT", value: 3 }]);
    runtime.stop();
    clock.advance(20);
    expect(runtime.snapshot().scanCount).toBe(3);
    expect(() => runtime.write(0, { dataType: "BOOL", value: true })).toThrow(
      RuntimeCommandRejected,
    );
  });

  it("exposes the standard function and block library", () => {
    const library: RuntimeLibrary = standardLibrary;
    expect(library.callFunction("ABS", [-7], "INT")).toBe(7);
    expect(callStandardFunction("ABS", [-7], "INT")).toBe(7);
    const block = createStandardFunctionBlock("TON");
    block.inputs[0]!.value = true;
    block.inputs[1]!.value = 10;
    block.execute(0);
    block.execute(10);
    expect(block.outputs.map((port) => port.value)).toEqual([true, 10]);
    expect(library.createFunctionBlock("TON").outputs.map((port) => port.value)).toEqual([
      false,
      0,
    ]);
  });
});

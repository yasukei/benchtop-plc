import { expect, it, vi } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

const sources = [
  `PROGRAM Main VAR c: Derived; n: INT; END_VAR
n := c.Count();
END_PROGRAM`,
  `CLASS Counter VAR n: INT; END_VAR
METHOD PUBLIC Count: INT
n := n + 1;
Count := n;
END_METHOD
END_CLASS`,
  `CLASS Derived EXTENDS Counter END_CLASS`,
];

it.each(["counter", "COUNTER.count"])(
  "halts inherited methods with %s without searching definition tables after load",
  (pou) => {
    const compiled = compileProject(sources);
    expect(compiled.diagnostics).toEqual([]);
    const ir = compiled.ir!;
    const clock = new VirtualClock();
    const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
    runtime.load(ir);
    runtime.watchBodies([]);
    runtime.setBreakpoints([{ pou, line: 4 }]);
    const blocks = ir.functionBlocks!;
    const find = vi.spyOn(blocks, "find");
    const methods = blocks.map((block) => vi.spyOn(block.methods!, "some"));
    try {
      runtime.step();
      expect(runtime.halted?.frames[0]).toMatchObject({
        kind: "METHOD",
        pou: "Counter.Count",
        span: { line: 4 },
      });
      runtime.continue();
      expect(runtime.state).toBe("STOP");
      expect(find).not.toHaveBeenCalled();
      for (const some of methods) expect(some).not.toHaveBeenCalled();
    } finally {
      find.mockRestore();
      for (const some of methods) some.mockRestore();
    }
  },
);

it("replaces method source mappings on load", () => {
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  const first = compileProject(sources);
  expect(first.diagnostics).toEqual([]);
  runtime.load(first.ir!);
  runtime.setBreakpoints([{ pou: "Counter", line: 4 }]);
  runtime.step();
  expect(runtime.state).toBe("HALT");

  const next = compileProject([
    `NAMESPACE Counter
PROGRAM Count VAR n: INT; END_VAR
n := 1;
n := n + 1;
END_PROGRAM
END_NAMESPACE`,
  ]);
  expect(next.diagnostics).toEqual([]);
  runtime.load(next.ir!);
  runtime.step();
  expect(runtime.state).toBe("STOP");
  expect(runtime.snapshot().scanCount).toBe(1);
});

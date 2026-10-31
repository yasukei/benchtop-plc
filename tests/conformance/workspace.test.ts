import { compile } from "@benchtop-plc/compiler";
import { validateValue } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";
import { describe, expect, it } from "vitest";

describe("workspace compiler/runtime contracts", () => {
  it("compiles and executes ST with persistent values across scans", () => {
    const compiled = compile(`PROGRAM Counter
VAR count: INT := 40; reached: BOOL; END_VAR
count := count + 1;
reached := count >= 42;
END_PROGRAM`);
    expect(compiled.diagnostics).toEqual([]);
    const clock = new VirtualClock();
    const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
    runtime.load(compiled.ir!);
    expect(runtime.step().variables).toEqual([
      { kind: "scalar", dataType: "INT", value: 41 },
      { kind: "scalar", dataType: "BOOL", value: false },
    ]);
    const snapshot = runtime.step();
    expect(snapshot.variables).toEqual([
      { kind: "scalar", dataType: "INT", value: 42 },
      { kind: "scalar", dataType: "BOOL", value: true },
    ]);
    for (const cell of snapshot.variables) {
      if (cell.kind !== "scalar") throw new Error("Expected scalar");
      expect(() => validateValue(cell.dataType, cell.value)).not.toThrow();
    }
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
  });
});

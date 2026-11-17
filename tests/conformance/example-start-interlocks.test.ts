import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import {
  parseDirectAddress,
  readDirectValue,
  writeDirectValue,
  type IoImage,
} from "@benchtop-plc/core";
import { readProject, writeProject } from "@benchtop-plc/project";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

it.each(["batch-mixer", "tank-station"])(
  "%s requires a fresh START after the first activation on load and restarts",
  (example) => {
    const loaded = readProject(
      readFileSync(new URL(`../../examples/${example}/project.xml`, import.meta.url), "utf8"),
    );
    expect(loaded.diagnostics).toEqual([]);
    const saved = writeProject(loaded.value!);
    expect(saved.diagnostics).toEqual([]);
    const project = readProject(saved.value!).value!;
    const compiled = compileProject(project.pous, project.dataTypes, project.configurationSource);
    expect(compiled.diagnostics).toEqual([]);
    const clock = new VirtualClock();
    const inputs: IoImage = Array<number>(64).fill(0);
    const runtime = createRuntime({
      clock,
      ticker: new VirtualTicker(clock),
      stages: { readInputs: () => [...inputs] },
    });
    runtime.load(compiled.ir!);
    const bit = (address: string, value: boolean) =>
      writeDirectValue(inputs, parseDirectAddress(address)!, { dataType: "BOOL", value });
    const starts = example === "tank-station" ? ["%IX0.0", "%IX0.2"] : ["%IX0.0"];
    const outputs = example === "tank-station" ? ["%QX0.0", "%QX0.2"] : ["%QX0.0"];
    const activationMs = example === "tank-station" ? 100 : 10;
    const scan = (expected: boolean) => {
      clock.advance(activationMs);
      expect(runtime.state).toBe("RUN");
      expect(runtime.diagnostic).toBeNull();
      for (const address of outputs)
        expect(
          readDirectValue(runtime.snapshot().outputs, parseDirectAddress(address)!, "BOOL"),
        ).toBe(expected);
    };
    for (const restart of ["load", "cold reset", "warm restart"]) {
      runtime.stop();
      if (restart === "cold reset") runtime.coldReset();
      if (restart === "warm restart") runtime.warmRestart();
      // External input levels are set before the first task activation, including after restart.
      if (example === "tank-station")
        writeDirectValue(inputs, parseDirectAddress("%IW3")!, { dataType: "INT", value: 50 });
      for (const address of starts) bit(address, true);
      runtime.run();
      scan(false);
      scan(false);
      for (const address of starts) bit(address, false);
      scan(false);
      for (const address of starts) bit(address, true);
      scan(true);
    }
  },
);

import { readFileSync } from "node:fs";
import { it } from "vitest";
import { performance } from "node:perf_hooks";
import { compileProject } from "@benchtop-plc/compiler";
import { readProject } from "@benchtop-plc/project";
import { createRuntime, standardLibrary } from "@benchtop-plc/runtime";
import { Interpreter } from "../../packages/runtime/src/interpreter.js";
import { Memory } from "../../packages/runtime/src/memory.js";

const project = readProject(
  readFileSync(new URL("../../examples/sorting-conveyor/project.xml", import.meta.url), "utf8"),
).value!;
const conveyor = compileProject(project.pous, project.dataTypes, project.configurationSource);
const loop = compileProject([
  `PROGRAM Main VAR i: DINT; total: DINT; END_VAR
   total := 0;
   FOR i := 1 TO 2000 DO total := total + AddOne(i); END_FOR;
   END_PROGRAM`,
  `FUNCTION AddOne : DINT VAR_INPUT x: DINT; END_VAR AddOne := x + 1; END_FUNCTION`,
]);
for (const [name, compiled] of [
  ["sorting conveyor", conveyor],
  ["loop with user calls", loop],
] as const) {
  if (!compiled.ir) throw new Error(JSON.stringify(compiled.diagnostics));
  const memory = new Memory(compiled.ir, standardLibrary);
  it(
    name,
    () => {
      const run = () => new Interpreter(memory, 0, () => true, standardLibrary).executeProgram();
      for (let n = 0; n < 500; n++) run();
      const batch = name === "sorting conveyor" ? 200 : 10;
      const samples: number[] = [];
      for (let sample = 0; sample < 31; sample++) {
        const start = performance.now();
        for (let n = 0; n < batch; n++) run();
        samples.push(((performance.now() - start) * 1000) / batch);
      }
      samples.sort((a, b) => a - b);
      console.log(`${name}: median ${samples[15]!.toFixed(3)} us/task run`);
    },
    30000,
  );
}

// Measure real task telemetry with a configured breakpoint that no body reaches.
// Snapshot serialization happens after finish(), outside the measured task time.
for (const [name, compiled] of [
  ["sorting conveyor", conveyor],
  ["loop with user calls", loop],
] as const) {
  for (const debugging of [false, true]) {
    it(`${name}: runtime debugging=${debugging}`, () => {
      const runtime = createRuntime({
        clock: { now: () => performance.now() },
        ticker: { start: () => () => {} },
      });
      runtime.load(compiled.ir!);
      runtime.watchBodies([]);
      if (debugging) runtime.setBreakpoints([{ pou: "UnreachableBenchmarkSource", line: 1 }]);
      const run = () => runtime.scanOnce().tasks[0]!.lastExecutionTimeMs;
      for (let n = 0; n < 500; n++) run();
      const batch = name === "sorting conveyor" ? 200 : 10;
      const samples: number[] = [];
      for (let sample = 0; sample < 31; sample++) {
        let duration = 0;
        for (let n = 0; n < batch; n++) duration += run();
        samples.push((duration * 1000) / batch);
      }
      samples.sort((a, b) => a - b);
      console.log(
        `${name} runtime debugging=${debugging}: median ${samples[15]!.toFixed(3)} us/task run`,
      );
    }, 30000);
  }
}

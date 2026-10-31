import { describe, expect, it } from "vitest";
import { compareMedians, parseMedians } from "../../scripts/runtime-benchmark.js";

describe("runtime benchmark comparison", () => {
  it("extracts only ordinary medians from noisy Vitest output", () => {
    expect(
      parseMedians(
        [
          "RUN v5.0.5",
          "sorting conveyor: median 70.542 us/task run",
          "loop with user calls: median 8776.739 us/task run",
          "sorting conveyor runtime debugging=false: median 99.000 us/task run",
          "6 passed",
        ].join("\n"),
      ),
    ).toEqual({ "sorting conveyor": 70.542, "loop with user calls": 8776.739 });
  });

  it.each(["", "0", "NaN", "-1", "1.2.3"])("rejects missing or invalid medians (%s)", (value) => {
    expect(() =>
      parseMedians(
        `sorting conveyor: median ${value} us/task run\nloop with user calls: median 1.000 us/task run`,
      ),
    ).toThrow("Expected one positive finite median for sorting conveyor.");
  });

  it("rejects duplicate runs and missing programs instead of reporting a partial comparison", () => {
    const conveyor = "sorting conveyor: median 1.000 us/task run";
    const loop = "loop with user calls: median 2.000 us/task run";
    expect(() => parseMedians(`${conveyor}\n${conveyor}\n${loop}`)).toThrow();
    expect(() => parseMedians(conveyor)).toThrow("loop with user calls");
  });

  it("compares each program separately and reports an exceeded budget without throwing", () => {
    expect(
      compareMedians(
        { "sorting conveyor": 10, "loop with user calls": 100 },
        { "sorting conveyor": 20, "loop with user calls": 250 },
      ),
    ).toEqual([
      { program: "sorting conveyor", baselineUs: 10, candidateUs: 20, ratio: 2 },
      { program: "loop with user calls", baselineUs: 100, candidateUs: 250, ratio: 2.5 },
    ]);
  });
});

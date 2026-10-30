import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatCoverageSummary } from "../../scripts/coverage-summary.js";

const root = resolve("fixture");
const file = (path: string) => resolve(root, path);
const counts = (covered: number, total: number) => ({ covered, total });
const coverage = (covered: number, total: number) => ({
  statements: counts(covered, total),
  branches: counts(covered, total),
  functions: counts(covered, total),
  lines: counts(covered, total),
});

describe("coverage job summary", () => {
  it("weights counts across files, includes untested files, and sorts packages", () => {
    const result = formatCoverageSummary(
      {
        total: coverage(99, 100),
        [file("packages/runtime/src/scan.ts")]: coverage(1, 1),
        [file("packages/compiler/src/parser.ts")]: {
          statements: counts(1, 2),
          branches: counts(1, 4),
          functions: counts(2, 2),
          lines: counts(2, 3),
        },
        [file("packages/compiler/src/nested/untested.ts")]: coverage(0, 8),
        [file("tests/conformance/trace.test.ts")]: coverage(1, 100),
        [file("packages/project/dist/index.js")]: coverage(1, 100),
        [resolve(root, "../other/packages/core/src/index.ts")]: coverage(1, 100),
      },
      root,
    );

    expect(result.split("\n").filter((line) => line.startsWith("| "))).toEqual([
      "| Package | Statements | Branches | Functions | Lines |",
      "| --- | ---: | ---: | ---: | ---: |",
      "| compiler | 10.00% (1/10) | 8.33% (1/12) | 20.00% (2/10) | 18.18% (2/11) |",
      "| runtime | 100.00% (1/1) | 100.00% (1/1) | 100.00% (1/1) | 100.00% (1/1) |",
    ]);
  });

  it("handles packages with no executable statements without NaN", () => {
    const result = formatCoverageSummary(
      { [file("packages/core/src/types.ts")]: coverage(0, 0) },
      root,
    );
    expect(result).toContain(
      "| core | 100.00% (0/0) | 100.00% (0/0) | 100.00% (0/0) | 100.00% (0/0) |",
    );
  });

  it("rejects reports that contain no package sources", () => {
    expect(() => formatCoverageSummary({ total: coverage(0, 0) }, root)).toThrow(
      "No package source coverage found.",
    );
  });
});

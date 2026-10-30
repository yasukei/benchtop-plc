import { readFileSync } from "node:fs";
import { relative, sep } from "node:path";
import process from "node:process";

const metrics = ["statements", "branches", "functions", "lines"] as const;
type Metric = (typeof metrics)[number];
type Counts = { total: number; covered: number };
type FileSummary = Record<Metric, Counts>;
type CoverageSummary = Record<string, FileSummary>;

/** Aggregate Istanbul's per-file counts, rather than averaging file percentages. */
export function formatCoverageSummary(summary: CoverageSummary, root: string): string {
  const packages = new Map<string, FileSummary>();
  for (const [file, coverage] of Object.entries(summary)) {
    if (file === "total") continue;
    const [directory, name, source] = relative(root, file).split(sep);
    if (directory !== "packages" || !name || source !== "src") continue;

    let totals = packages.get(name);
    if (!totals) {
      totals = {
        statements: { total: 0, covered: 0 },
        branches: { total: 0, covered: 0 },
        functions: { total: 0, covered: 0 },
        lines: { total: 0, covered: 0 },
      };
      packages.set(name, totals);
    }
    for (const metric of metrics) {
      totals[metric].total += coverage[metric].total;
      totals[metric].covered += coverage[metric].covered;
    }
  }

  if (packages.size === 0) throw new Error("No package source coverage found.");

  const rows = [...packages]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, totals]) => {
      const cells = metrics.map((metric) => {
        const { covered, total } = totals[metric];
        // Match Istanbul's convention for files without executable code.
        const percent = total === 0 ? 100 : (covered / total) * 100;
        return `${percent.toFixed(2)}% (${covered}/${total})`;
      });
      return `| ${name} | ${cells.join(" | ")} |`;
    });

  return [
    "## Unit and conformance test coverage",
    "",
    "V8 coverage of package sources, including files not exercised by tests. Cells show percent and covered/total counts.",
    "",
    "| Package | Statements | Branches | Functions | Lines |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "Download the `unit-test-coverage` artifact and open `index.html` to inspect uncovered paths. No coverage thresholds are enforced.",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const summary = JSON.parse(
    readFileSync("coverage/coverage-summary.json", "utf8"),
  ) as CoverageSummary;
  process.stdout.write(formatCoverageSummary(summary, process.cwd()));
}

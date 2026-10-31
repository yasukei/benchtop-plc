import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";

const programs = ["sorting conveyor", "loop with user calls"] as const;
const harnessFiles = [
  "runtime-benchmark.config.ts",
  "vitest.config.ts",
  "tests/benchmarks/runtime.bench.ts",
  "examples/sorting-conveyor/project.xml",
];
type Medians = Record<(typeof programs)[number], number>;

export function parseMedians(log: string): Medians {
  const medians = {} as Medians;
  for (const program of programs) {
    const matches = [
      ...log.matchAll(new RegExp(`^${program}: median ([0-9.]+) us/task run$`, "gm")),
    ];
    const value = Number(matches[0]?.[1]);
    if (matches.length !== 1 || !Number.isFinite(value) || value <= 0) {
      throw new Error(`Expected one positive finite median for ${program}.`);
    }
    medians[program] = value;
  }
  return medians;
}

export function compareMedians(baseline: Medians, candidate: Medians) {
  return programs.map((program) => ({
    program,
    baselineUs: baseline[program],
    candidateUs: candidate[program],
    ratio: candidate[program] / baseline[program],
  }));
}

function command(cwd: string, executable: string, args: string[]): string {
  const result = spawnSync(executable, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Use disposable checkouts: the shared harness and script replace files in both. */
function measure(baselinePath: string, candidatePath: string, outputPath: string) {
  const harness = resolve(import.meta.dirname, "..");
  const baseline = resolve(baselinePath);
  const candidate = resolve(candidatePath);
  const output = resolve(outputPath);
  if (baseline === candidate || baseline === harness || candidate === harness) {
    throw new Error("Use two distinct disposable checkouts, separate from the harness checkout.");
  }
  mkdirSync(output, { recursive: true });
  const commit = (path: string) => command(path, "git", ["rev-parse", "HEAD"]);
  const metadata = {
    measuredAt: new Date().toISOString(),
    baselineCommit: commit(baseline),
    candidateCommit: commit(candidate),
    harnessCommit: commit(harness),
    harnessSha256: Object.fromEntries(
      harnessFiles.map((file) => [
        file,
        createHash("sha256")
          .update(readFileSync(resolve(harness, file)))
          .digest("hex"),
      ]),
    ),
    node: process.version,
    pnpm: command(harness, "pnpm", ["--version"]),
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpus: cpus().length,
    memoryBytes: totalmem(),
    runner: process.env.RUNNER_ENVIRONMENT ?? "local",
    runnerImage: process.env.ImageOS ?? "unknown",
    runnerImageVersion: process.env.ImageVersion ?? "unknown",
  };
  writeFileSync(resolve(output, "environment.json"), `${JSON.stringify(metadata, null, 2)}\n`);

  const measurements: Medians[] = [];
  for (const [label, checkout] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ] as const) {
    for (const file of harnessFiles) {
      const destination = resolve(checkout, file);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(resolve(harness, file), destination);
    }
    // The pre-#194 revision has no bench:runtime script. Give both the same command.
    const manifestPath = resolve(checkout, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      scripts: Record<string, string>;
    };
    manifest.scripts["bench:runtime"] =
      "vitest run -c runtime-benchmark.config.ts --disableConsoleIntercept";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`Installing locked dependencies for ${label}...\n`);
    const installLog = command(checkout, "pnpm", ["install", "--frozen-lockfile"]);
    writeFileSync(resolve(output, `${label}-install.log`), `${installLog}\n`);
    process.stdout.write(`Measuring ${label}...\n`);
    // Runtime-debugging cases use APIs absent from the baseline; compare only
    // the two ordinary interpreter cases supported by both revisions.
    const result = spawnSync(
      "pnpm",
      ["bench:runtime", "--testNamePattern=^(sorting conveyor|loop with user calls)$"],
      { cwd: checkout, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
    );
    const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    writeFileSync(resolve(output, `${label}.log`), log);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Benchmark failed: see ${label}.log.`);
    measurements.push(parseMedians(log));
  }
  const comparisons = compareMedians(measurements[0]!, measurements[1]!);
  writeFileSync(
    resolve(output, "comparison.json"),
    `${JSON.stringify({ ...metadata, comparisons }, null, 2)}\n`,
  );
  const summary = [
    "## ADR 0018 runtime benchmark",
    "",
    `- Baseline: \`${metadata.baselineCommit}\` (pre-#194).`,
    `- Candidate: \`${metadata.candidateCommit}\`.`,
    `- Harness: \`${metadata.harnessCommit}\`; identical configuration, benchmark and conveyor fixture copied into both checkouts.`,
    `- Environment: ${metadata.platform} ${metadata.release} ${metadata.arch}; ${metadata.cpu}; ${metadata.logicalCpus} logical CPUs; Node ${metadata.node}; pnpm ${metadata.pnpm}.`,
    `- Runner: ${metadata.runner}; image ${metadata.runnerImage} ${metadata.runnerImageVersion}; measured ${metadata.measuredAt}.`,
    "",
    "Sequential runs in one job/session. Each warms up 500 runs, then takes the median of 31 batches (200 conveyor or 10 loop runs). No breakpoint or step is requested.",
    "",
    "| Program | Baseline (µs/task run) | Candidate (µs/task run) | Candidate / baseline | ADR 0018 ≤2× |",
    "| --- | ---: | ---: | ---: | --- |",
    ...comparisons.map(
      ({ program, baselineUs, candidateUs, ratio }) =>
        `| ${program} | ${baselineUs.toFixed(3)} | ${candidateUs.toFixed(3)} | ${ratio.toFixed(2)}× | ${ratio <= 2 ? "Within budget" : "Exceeded; follow-up required"} |`,
    ),
    "",
    "Timing is informational and never fails CI for exceeding the budget. Shared runners are noisy; only this paired measurement assesses the 2× budget. Previously recorded measurements are historical information, not a comparable baseline.",
    "",
    "The runtime-benchmark artifact contains raw logs, environment and harness hashes, machine-readable comparisons, and this summary.",
    "",
  ].join("\n");
  writeFileSync(resolve(output, "summary.md"), summary);
  process.stdout.write(summary);
}

if (import.meta.main) {
  try {
    const [baseline, candidate, output, ...extra] = process.argv.slice(2);
    if (!baseline || !candidate || !output || extra.length) {
      throw new Error("Usage: node scripts/runtime-benchmark.ts <baseline> <candidate> <output>");
    }
    measure(baseline, candidate, output);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

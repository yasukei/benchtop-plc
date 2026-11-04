import { spawnSync } from "node:child_process";
import { globSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareRelease } from "../../scripts/release-prepare.js";

const changelog = `# Changelog

## [Unreleased]

### Fixed

- Keep this entry and its manually written summary.

## [0.8.0] - 2026-10-27

Previous release notes.

[Unreleased]: https://github.com/yasukei/benchtop-plc/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/yasukei/benchtop-plc/compare/v0.7.0...v0.8.0
`;
const manifest = '{\n  "version": "0.8.0",\n  "private": true,\n  "type": "module"\n}\n';
const xml =
  '<?xml version="1.0"?><project><fileHeader productVersion="0.8.0" creationDateTime="2026-10-27T00:00:00Z"/><body>0.8.0</body></project>';
const invalidDates = [
  "",
  "2026-13-01",
  "2026-00-01",
  "2026-01-00",
  "2026-01-32",
  "2026-02-30",
  "2026-02-29",
  "1900-02-29",
  "2026-04-31",
  "2026/10/31",
  "2026-1-01",
  "26-10-31",
  "2026-10-31T00:00:00Z",
  "2026-10-31\n",
];

describe("release preparation", () => {
  let root: string;
  const read = (file: string) => readFileSync(join(root, file), "utf8");
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  };
  const snapshot = () =>
    Object.fromEntries(
      globSync(
        ["package.json", "packages/*/package.json", "examples/**/project.xml", "CHANGELOG.md"],
        {
          cwd: root,
        },
      ).map((file) => [file, read(file)]),
    );
  const runCli = (...args: string[]) => {
    write(
      "scripts/release-prepare.ts",
      readFileSync(new URL("../../scripts/release-prepare.ts", import.meta.url), "utf8"),
    );
    return spawnSync(process.execPath, [join(root, "scripts/release-prepare.ts"), ...args], {
      cwd: root,
      encoding: "utf8",
    });
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "benchtop-release-"));
    write("package.json", manifest);
    write("packages/core/package.json", manifest);
    write("packages/future-package/package.json", manifest);
    write("examples/blink/project.xml", xml);
    write("examples/nested/future-example/project.xml", xml);
    write("CHANGELOG.md", changelog);
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it("defaults to today's UTC date even when the local date is the following day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:30:00+09:00"));
    expect(prepareRelease(root, "0.9.0")).toBe(6);
    expect(read("CHANGELOG.md")).toContain("## [0.9.0] - 2026-10-31\n");
  });

  it.each(["2024-02-29", "2000-02-29", "2026-12-31"])("accepts calendar date %s", (date) => {
    prepareRelease(root, "0.9.0", date);
    expect(read("CHANGELOG.md")).toContain(`## [0.9.0] - ${date}\n`);
  });

  it.each(invalidDates)("rejects date %j without changing any release file", (date) => {
    const before = snapshot();
    expect(() => prepareRelease(root, "0.9.0", date)).toThrow(
      "Expected a real calendar date in YYYY-MM-DD form.",
    );
    expect(snapshot()).toEqual(before);
  });

  it.each([[], ["--date", "2026-10-31"]])(
    "prepares a release through the CLI with %j",
    (...extra) => {
      const before = new Date().toISOString().slice(0, 10);
      const result = runCli("0.9.0", ...extra);
      const after = new Date().toISOString().slice(0, 10);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Prepared 0.9.0 in 6 files.");
      expect(read("CHANGELOG.md")).toMatch(
        new RegExp(`## \\[0\\.9\\.0\\] - (${extra[1] ?? `${before}|${after}`})\\n`),
      );
      expect(read("package.json")).toBe(manifest.replace("0.8.0", "0.9.0"));
      expect(read("examples/nested/future-example/project.xml")).toBe(
        xml.replace('productVersion="0.8.0"', 'productVersion="0.9.0"'),
      );
    },
  );

  it.each(invalidDates)("rejects CLI date %j without changing any release file", (date) => {
    const before = snapshot();
    const result = runCli("0.9.0", "--date", date);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Expected a real calendar date in YYYY-MM-DD form.\n");
    expect(result.stdout).toBe("");
    expect(snapshot()).toEqual(before);
  });

  it.each([
    [],
    ["0.9.0", "--date"],
    ["0.9.0", "--unknown", "2026-10-31"],
    ["0.9.0", "--date", "2026-10-31", "extra"],
  ])("rejects malformed CLI arguments %j before writing", (...args) => {
    const before = snapshot();
    const result = runCli(...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("Usage: pnpm release:prepare <version> [--date YYYY-MM-DD]\n");
    expect(result.stdout).toBe("");
    expect(snapshot()).toEqual(before);
  });

  it.each(["0.9.0", "0.8.1", "1.0.0-rc.1+build.01"])(
    "prepares %s across packages, recursive examples and the changelog",
    (version) => {
      expect(prepareRelease(root, version, "2026-10-31")).toBe(6);
      for (const file of [
        "package.json",
        "packages/core/package.json",
        "packages/future-package/package.json",
      ]) {
        expect(read(file)).toBe(manifest.replace("0.8.0", version));
      }
      for (const file of [
        "examples/blink/project.xml",
        "examples/nested/future-example/project.xml",
      ]) {
        expect(read(file)).toBe(
          xml.replace('productVersion="0.8.0"', `productVersion="${version}"`),
        );
      }
      expect(read("CHANGELOG.md")).toBe(
        changelog
          .replace("## [Unreleased]\n", `## [Unreleased]\n\n## [${version}] - 2026-10-31\n`)
          .replace(
            "[Unreleased]: https://github.com/yasukei/benchtop-plc/compare/v0.8.0...HEAD",
            `[Unreleased]: https://github.com/yasukei/benchtop-plc/compare/v${version}...HEAD\n[${version}]: https://github.com/yasukei/benchtop-plc/compare/v0.8.0...v${version}`,
          ),
      );
    },
  );

  it("preserves XML namespace prefixes, whitespace and single quotes", () => {
    write("examples/blink/project.xml", "<tc6:fileHeader productVersion = '0.8.0'/>");
    prepareRelease(root, "0.9.0");
    expect(read("examples/blink/project.xml")).toBe("<tc6:fileHeader productVersion = '0.9.0'/>");
  });

  it.each(["", "v0.9.0", "0.9", "01.0.0", "1.0.0-01", "1.0.0+", "0.9.0\n", "0.8.0"])(
    "rejects an invalid or current version %j without writing files",
    (version) => {
      expect(() => prepareRelease(root, version)).toThrow();
      expect(read("package.json")).toBe(manifest);
      expect(read("CHANGELOG.md")).toBe(changelog);
      expect(read("examples/blink/project.xml")).toBe(xml);
    },
  );

  it.each([
    ["CHANGELOG.md", changelog.replace("## [Unreleased]", "## Pending")],
    ["CHANGELOG.md", changelog.replace("v0.8.0...HEAD", "v0.7.0...HEAD")],
    ["CHANGELOG.md", `${changelog}\n## [0.9.0] - 2026-10-30\n`],
    ["CHANGELOG.md", `${changelog}\n[0.9.0]: https://example.com\n`],
    ["examples/nested/future-example/project.xml", "<fileHeader/>"],
    ["packages/future-package/package.json", '{"private": true}'],
  ])("rejects incomplete release metadata in %s before writing", (file, text) => {
    write(file, text);
    expect(() => prepareRelease(root, "0.9.0")).toThrow();
    expect(read("package.json")).toBe(manifest);
    expect(read("packages/core/package.json")).toBe(manifest);
    expect(read("examples/blink/project.xml")).toBe(xml);
    expect(read(file)).toBe(text);
  });
});

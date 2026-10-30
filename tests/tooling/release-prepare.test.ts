import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
const manifest = '{\n  "version": "0.8.0",\n  "private": true\n}\n';
const xml =
  '<?xml version="1.0"?><project><fileHeader productVersion="0.8.0" creationDateTime="2026-10-27T00:00:00Z"/><body>0.8.0</body></project>';

describe("release preparation", () => {
  let root: string;
  const read = (file: string) => readFileSync(join(root, file), "utf8");
  const write = (file: string, text: string) => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
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
  afterEach(() => rmSync(root, { recursive: true, force: true }));

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

import { globSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

// SemVer 2.0.0: numeric identifiers cannot have leading zeroes except in build metadata.
const numeric = "(?:0|[1-9][0-9]*)";
const prerelease = `(?:${numeric}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
const semver = new RegExp(
  `^${numeric}\\.${numeric}\\.${numeric}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
);

/** Prepare all edits before writing, so invalid input leaves release files untouched. */
export function prepareRelease(
  root: string,
  version: string,
  date = new Date().toISOString().slice(0, 10),
): number {
  if (!semver.test(version)) throw new Error("Expected a SemVer version, for example 0.9.0.");

  const edits = new Map<string, string>();
  const read = (file: string) => readFileSync(resolve(root, file), "utf8");
  const current = (JSON.parse(read("package.json")) as { version: string }).version;
  if (version === current) throw new Error(`Version ${version} is already current.`);

  for (const file of ["package.json", ...globSync("packages/*/package.json", { cwd: root })]) {
    const text = read(file);
    const manifest = JSON.parse(text) as { version: string };
    if (typeof manifest.version !== "string") throw new Error(`Missing version in ${file}.`);
    // Replace just the field, preserving formatting and all other package metadata.
    edits.set(file, text.replace(/("version"\s*:\s*")[^"]*"/, `$1${version}"`));
  }

  for (const file of globSync("examples/**/project.xml", { cwd: root })) {
    const text = read(file);
    const header = /(<(?:[\w-]+:)?fileHeader\b[^>]*\sproductVersion\s*=\s*)(["'])[^"']*\2/;
    if (!header.test(text)) throw new Error(`Missing fileHeader productVersion in ${file}.`);
    // Do not serialize XML: source text, timestamps and layout must stay byte-for-byte intact.
    edits.set(file, text.replace(header, `$1$2${version}$2`));
  }

  let changelog = read("CHANGELOG.md");
  if (changelog.includes(`## [${version}]`) || changelog.includes(`[${version}]:`)) {
    throw new Error(`Version ${version} is already in CHANGELOG.md.`);
  }
  const heading = "## [Unreleased]\n";
  const comparison = changelog.match(
    /^\[Unreleased\]: (https:\/\/\S+\/compare\/)v(\S+)\.\.\.HEAD$/m,
  );
  if (!changelog.includes(heading) || !comparison || comparison[2] !== current) {
    throw new Error("Expected an Unreleased heading and comparison link for the current version.");
  }
  changelog = changelog.replace(heading, `${heading}\n## [${version}] - ${date}\n`);
  changelog = changelog.replace(
    comparison[0],
    `[Unreleased]: ${comparison[1]}v${version}...HEAD\n[${version}]: ${comparison[1]}v${current}...v${version}`,
  );
  edits.set("CHANGELOG.md", changelog);

  for (const [file, text] of edits) writeFileSync(resolve(root, file), text);
  return edits.size;
}

if (import.meta.main) {
  try {
    const [version, ...extra] = process.argv.slice(2);
    if (!version || extra.length) throw new Error("Usage: pnpm release:prepare <version>");
    const count = prepareRelease(resolve(import.meta.dirname, ".."), version);
    process.stdout.write(
      `Prepared ${version} in ${count} files. Review the diff and write the release summary.\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

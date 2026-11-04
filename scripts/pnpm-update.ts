import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

interface PnpmMetadata {
  versions: Record<string, unknown>;
  time: Record<string, string>;
}

const stableVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const cooldown = 7 * 24 * 60 * 60 * 1000;

function compareVersions(left: string, right: string): number {
  const other = right.split(".").map(Number);
  for (const [index, part] of left.split(".").entries()) {
    const difference = Number(part) - other[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/** npm publication dates, rather than dist-tags, determine the seven-day cooldown. */
export function selectPnpmUpdate(
  current: string,
  metadata: PnpmMetadata,
  now: number,
): string | undefined {
  if (!stableVersion.test(current)) throw new Error("Expected a pinned stable pnpm version.");
  let latest = current;
  for (const version of Object.keys(metadata.versions)) {
    if (!stableVersion.test(version)) continue;
    const published = Date.parse(metadata.time[version] ?? "");
    if (published <= now - cooldown && compareVersions(version, latest) > 0) latest = version;
  }
  return latest === current ? undefined : latest;
}

/** Preserve the manifest's formatting and every field except packageManager. */
export function preparePnpmUpdate(root: string, metadata: PnpmMetadata, now: number) {
  const path = resolve(root, "package.json");
  const text = readFileSync(path, "utf8");
  const manifest = JSON.parse(text) as { packageManager?: string };
  const pinned = manifest.packageManager;
  if (!pinned?.startsWith("pnpm@")) throw new Error("Expected packageManager to pin pnpm.");
  const current = pinned.slice("pnpm@".length);
  const latest = selectPnpmUpdate(current, metadata, now);
  if (!latest) return undefined;
  writeFileSync(path, text.replace(/("packageManager"\s*:\s*")[^"]*"/, `$1pnpm@${latest}"`));
  return { current, latest };
}

if (import.meta.main) {
  try {
    const response = await fetch("https://registry.npmjs.org/pnpm", {
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`npm registry returned ${response.status}.`);
    const metadata = (await response.json()) as PnpmMetadata;
    const update = preparePnpmUpdate(resolve(import.meta.dirname, ".."), metadata, Date.now());
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        update
          ? `changed=true\ncurrent=${update.current}\nlatest=${update.latest}\n`
          : "changed=false\n",
      );
    }
    process.stdout.write(
      update ? `Update pnpm from ${update.current} to ${update.latest}.\n` : "pnpm is current.\n",
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

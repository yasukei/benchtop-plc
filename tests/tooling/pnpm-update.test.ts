import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preparePnpmUpdate, selectPnpmUpdate } from "../../scripts/pnpm-update.js";

const now = Date.parse("2026-11-04T06:17:00Z");
const eligible = "2026-10-01T00:00:00Z";
function metadata(time: Record<string, string>, latest: string) {
  return {
    "dist-tags": { latest },
    versions: Object.fromEntries(Object.keys(time).map((version) => [version, {}])),
    time,
  };
}

describe("pnpm release selection", () => {
  it("excludes releases above latest even after the cooldown", () => {
    expect(
      selectPnpmUpdate(
        "12.16.1",
        metadata({ "12.16.1": eligible, "12.17.0": eligible }, "12.16.1"),
        now,
      ),
    ).toBeUndefined();
  });

  it("selects latest once it has passed the cooldown", () => {
    expect(
      selectPnpmUpdate(
        "12.16.1",
        metadata({ "12.16.2": eligible, "12.17.0": eligible, "13.0.0": eligible }, "12.17.0"),
        now,
      ),
    ).toBe("12.17.0");
  });

  it("selects the highest eligible release below latest while latest is cooling down", () => {
    expect(
      selectPnpmUpdate(
        "12.16.1",
        metadata(
          {
            "12.17.0": "2026-11-03T00:00:00Z",
            "13.0.0": eligible,
            "12.16.3": eligible,
            "12.16.2": eligible,
          },
          "12.17.0",
        ),
        now,
      ),
    ).toBe("12.16.3");
  });

  it("selects the highest semantic version, regardless of publication or object order", () => {
    expect(
      selectPnpmUpdate(
        "10.9.9",
        metadata({ "12.9.0": eligible, "12.10.0": eligible, "11.99.0": "2026-10-27" }, "12.10.0"),
        now,
      ),
    ).toBe("12.10.0");
  });

  it("includes a release exactly seven days old and excludes a release one millisecond newer", () => {
    expect(
      selectPnpmUpdate(
        "12.16.1",
        metadata(
          {
            "12.16.2": "2026-10-28T06:17:00.000Z",
            "12.16.3": "2026-10-28T06:17:00.001Z",
          },
          "12.16.3",
        ),
        now,
      ),
    ).toBe("12.16.2");
  });

  it("ignores prereleases, invalid versions, and missing or invalid publication dates", () => {
    const releases = metadata(
      {
        "13.0.0-rc.1": eligible,
        "13.0.0-beta.2": eligible,
        "v13.0.0": eligible,
        "013.0.0": eligible,
        "14.0.0": "invalid",
        "15.0.0": eligible,
        "12.16.2": eligible,
      },
      "15.0.0",
    );
    delete releases.time["15.0.0"];
    expect(selectPnpmUpdate("12.16.1", releases, now)).toBe("12.16.2");
  });

  it("does not select unpublished versions that remain in the publication history", () => {
    expect(
      selectPnpmUpdate(
        "12.16.1",
        { "dist-tags": { latest: "13.0.0" }, versions: {}, time: { "13.0.0": eligible } },
        now,
      ),
    ).toBeUndefined();
  });

  it.each(["12.16.1", "12.17.0", "13.0.0"])(
    "does nothing when %s is already current or newer than eligible releases",
    (current) => {
      expect(
        selectPnpmUpdate(
          current,
          metadata({ "12.16.1": eligible, "14.0.0": "2026-11-03T00:00:00Z" }, "14.0.0"),
          now,
        ),
      ).toBeUndefined();
    },
  );

  it("does nothing when no releases are available", () => {
    expect(selectPnpmUpdate("12.16.1", metadata({}, "12.16.1"), now)).toBeUndefined();
  });
});

describe("pnpm manifest update", () => {
  let root: string;
  const manifest =
    '{\n  "packageManager": "pnpm@12.16.1",\n  "private": true,\n  "type": "module"\n}\n';
  const releases = metadata({ "12.16.2": eligible }, "12.16.2");
  const read = () => readFileSync(join(root, "package.json"), "utf8");

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "benchtop-pnpm-"));
    writeFileSync(join(root, "package.json"), manifest);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("updates only packageManager to the exact version and leaves a repeat run unchanged", () => {
    expect(preparePnpmUpdate(root, releases, now)).toEqual({
      current: "12.16.1",
      latest: "12.16.2",
    });
    const updated = manifest.replace("pnpm@12.16.1", "pnpm@12.16.2");
    expect(read()).toBe(updated);
    expect(preparePnpmUpdate(root, releases, now)).toBeUndefined();
    expect(read()).toBe(updated);
  });

  it("leaves an already current manifest byte-for-byte unchanged", () => {
    expect(
      preparePnpmUpdate(root, metadata({ "12.16.1": eligible }, "12.16.1"), now),
    ).toBeUndefined();
    expect(read()).toBe(manifest);
  });

  it.each([
    undefined,
    {},
    { latest: "" },
    { latest: "12.17.0-rc.1" },
    { latest: "12.17.0+build.1" },
    { latest: "v12.17.0" },
    { latest: "012.17.0" },
    { latest: "12.17" },
  ])("rejects missing or invalid dist-tags %j without writing", (tags) => {
    expect(() => preparePnpmUpdate(root, { ...releases, "dist-tags": tags }, now)).toThrow(
      "Expected npm dist-tags.latest to be a stable pnpm version.",
    );
    expect(read()).toBe(manifest);
  });

  it("prints pnpm is current and preserves the manifest when only releases above latest qualify", () => {
    mkdirSync(join(root, "scripts"));
    writeFileSync(
      join(root, "scripts/pnpm-update.ts"),
      readFileSync(new URL("../../scripts/pnpm-update.ts", import.meta.url), "utf8"),
    );
    const fixture = metadata({ "12.16.1": eligible, "12.17.0": eligible }, "12.16.1");
    const preload = join(root, "registry.mjs");
    writeFileSync(
      preload,
      `Date.now = () => ${now};\nglobalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(fixture))});\n`,
    );
    const output = join(root, "github-output");
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(preload).href, join(root, "scripts/pnpm-update.ts")],
      { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_OUTPUT: output } },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("pnpm is current.\n");
    expect(readFileSync(output, "utf8")).toBe("changed=false\n");
    expect(read()).toBe(manifest);
  });

  it.each([undefined, "npm@12.16.1", "pnpm@^12.16.1", "pnpm@12.17.0-rc.1"])(
    "rejects an unsupported packageManager %j without writing",
    (packageManager) => {
      const original = JSON.stringify({ packageManager });
      writeFileSync(join(root, "package.json"), original);
      expect(() => preparePnpmUpdate(root, releases, now)).toThrow();
      expect(read()).toBe(original);
    },
  );
});

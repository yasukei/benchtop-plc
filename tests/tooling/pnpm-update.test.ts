import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preparePnpmUpdate, selectPnpmUpdate } from "../../scripts/pnpm-update.js";

const now = Date.parse("2026-11-04T06:17:00Z");
const eligible = "2026-10-01T00:00:00Z";
function metadata(time: Record<string, string>) {
  return { versions: Object.fromEntries(Object.keys(time).map((version) => [version, {}])), time };
}

describe("pnpm release selection", () => {
  it("selects the highest semantic version, regardless of publication or object order", () => {
    expect(
      selectPnpmUpdate(
        "10.9.9",
        metadata({ "12.9.0": eligible, "12.10.0": eligible, "11.99.0": "2026-10-27" }),
        now,
      ),
    ).toBe("12.10.0");
  });

  it("includes a release exactly seven days old and excludes a release one millisecond newer", () => {
    expect(
      selectPnpmUpdate(
        "12.16.1",
        metadata({
          "12.16.2": "2026-10-28T06:17:00.000Z",
          "12.16.3": "2026-10-28T06:17:00.001Z",
        }),
        now,
      ),
    ).toBe("12.16.2");
  });

  it("ignores prereleases, invalid versions, and missing or invalid publication dates", () => {
    const releases = metadata({
      "13.0.0-rc.1": eligible,
      "13.0.0-beta.2": eligible,
      "v13.0.0": eligible,
      "013.0.0": eligible,
      "14.0.0": "invalid",
      "15.0.0": eligible,
      "12.16.2": eligible,
    });
    delete releases.time["15.0.0"];
    expect(selectPnpmUpdate("12.16.1", releases, now)).toBe("12.16.2");
  });

  it("does not select unpublished versions that remain in the publication history", () => {
    expect(
      selectPnpmUpdate("12.16.1", { versions: {}, time: { "13.0.0": eligible } }, now),
    ).toBeUndefined();
  });

  it.each(["12.16.1", "12.17.0", "13.0.0"])(
    "does nothing when %s is already current or newer than eligible releases",
    (current) => {
      expect(
        selectPnpmUpdate(
          current,
          metadata({ "12.16.1": eligible, "14.0.0": "2026-11-03T00:00:00Z" }),
          now,
        ),
      ).toBeUndefined();
    },
  );

  it("does nothing when no releases are available", () => {
    expect(selectPnpmUpdate("12.16.1", metadata({}), now)).toBeUndefined();
  });
});

describe("pnpm manifest update", () => {
  let root: string;
  const manifest = '{\n  "packageManager": "pnpm@12.16.1",\n  "private": true\n}\n';
  const releases = metadata({ "12.16.2": eligible });
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
    expect(preparePnpmUpdate(root, metadata({ "12.16.1": eligible }), now)).toBeUndefined();
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

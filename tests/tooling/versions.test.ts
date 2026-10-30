import { globSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readProject } from "@benchtop-plc/project";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const version = (JSON.parse(read("package.json")) as { version: string }).version;
const packages = globSync("packages/*/package.json", { cwd: root }).sort();
const examples = globSync("examples/**/project.xml", { cwd: root }).sort();

describe("repository release version", () => {
  it("discovers workspace packages and example projects", () => {
    expect(packages.length).toBeGreaterThan(0);
    expect(examples.length).toBeGreaterThan(0);
  });

  it.each(packages)("%s agrees with the root version", (file) => {
    expect((JSON.parse(read(file)) as { version: string }).version).toBe(version);
  });

  it.each(examples)("%s has the current productVersion", (file) => {
    const project = readProject(read(file));
    expect(project.diagnostics).toEqual([]);
    expect(project.value?.fileHeader.productVersion).toBe(version);
  });
});

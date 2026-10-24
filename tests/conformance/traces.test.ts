import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readProject, writeProject } from "@benchtop-plc/project";
import { parseTrace, runTrace } from "./trace.js";

const root = new URL("./", import.meta.url);
const cases = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "fixtures")
  .map((entry) => entry.name)
  .sort();
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const loadTrace = (name: string) => parseTrace(JSON.parse(read(`${name}/trace.json`)));

describe("data-driven ST conformance", () => {
  it("keeps the reference trace source identical to the golden IR fixture", () => {
    expect(read("reference/program.st")).toBe(read("fixtures/reference.st"));
  });

  it.each(cases)("%s", (name) => {
    const files = readdirSync(new URL(`${name}/`, root))
      .filter((file) => file.endsWith(".st"))
      .sort();
    const sources = files
      .filter((file) => !file.endsWith(".type.st") && !file.endsWith(".config.st"))
      .map((file) => read(`${name}/${file}`));
    const dataTypes = files
      .filter((file) => file.endsWith(".type.st"))
      .map((file) => read(`${name}/${file}`));
    const configuration = files.find((file) => file.endsWith(".config.st"));
    runTrace(
      name,
      sources,
      loadTrace(name),
      dataTypes,
      configuration ? read(`${name}/${configuration}`) : undefined,
    );
  });

  it("loads and compiles the blink XML example and passes the reference trace", () => {
    const result = readProject(read("../../examples/blink/project.xml"));
    expect(result.diagnostics).toEqual([]);
    if (!result.value) throw new Error("Expected the blink project");
    expect(result.value.pous[0]!).toBe(read("reference/program.st"));
    expect(result.value.task.interval).toBe("PT0.01S");
    runTrace("examples/blink", result.value.pous[0]!, loadTrace("reference"));
  });
  it("loads and compiles the running light XML example and passes its bidirectional trace", () => {
    const result = readProject(read("../../examples/running-light/project.xml"));
    expect(result.diagnostics).toEqual([]);
    if (!result.value) throw new Error("Expected the running light project");
    expect(result.value.pous[0]!).toBe(read("running-light/program.st"));
    expect(result.value.task.interval).toBe("PT0.01S");
    runTrace("examples/running-light", result.value.pous[0]!, loadTrace("running-light"));
  });
  it("preserves the motor starters POUs on save/reopen and passes their interlocked trace", () => {
    const result = readProject(read("../../examples/motor-starters/project.xml"));
    expect(result.diagnostics).toEqual([]);
    if (!result.value) throw new Error("Expected the motor starters project");
    expect(result.value.pous).toEqual(
      ["program", "motor-starter", "can-start"].map((name) => read(`motor-starters/${name}.st`)),
    );
    expect(result.value.task.interval).toBe("PT0.01S");
    const saved = writeProject(result.value);
    expect(saved.diagnostics).toEqual([]);
    expect(saved.value).not.toBeNull();
    const reopened = readProject(saved.value!);
    expect(reopened).toEqual(result);
    runTrace("examples/motor-starters", reopened.value!.pous, loadTrace("motor-starters"));
  });
  it("preserves the batch mixer texts on save/reopen and passes all recipe timings", () => {
    const result = readProject(read("../../examples/batch-mixer/project.xml"));
    expect(result.diagnostics).toEqual([]);
    if (!result.value) throw new Error("Expected the batch mixer project");
    expect(result.value.pous).toEqual([read("batch-mixer/program.st")]);
    expect(result.value.dataTypes).toEqual(
      ["mixer-state", "recipe"].map((name) => read(`batch-mixer/${name}.type.st`)),
    );
    expect(result.value.task.interval).toBe("PT0.01S");
    const saved = writeProject(result.value);
    expect(saved.diagnostics).toEqual([]);
    expect(saved.value).not.toBeNull();
    const reopened = readProject(saved.value!);
    expect(reopened).toEqual(result);
    runTrace(
      "examples/batch-mixer",
      reopened.value!.pous,
      loadTrace("batch-mixer"),
      reopened.value!.dataTypes,
    );
  });
});

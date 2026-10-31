import { describe, expect, it } from "vitest";
import {
  durationNanoseconds,
  joinProgram,
  readProject,
  splitProgram,
  TC6_NAMESPACE,
  writeProject,
} from "./index.js";
import type { Project, SplitProgram } from "./index.js";

const source = "PROGRAM Counter\nVAR count: INT; END_VAR\ncount := count + 1;\nEND_PROGRAM";

describe("@benchtop-plc/project public API", () => {
  it("splits and joins an ST program without losing declarations or its body", () => {
    const result = splitProgram(source);
    expect(result.diagnostics).toEqual([]);
    const program: SplitProgram = result.value!;
    expect(program).toMatchObject({ name: "Counter", variables: [{ name: "count", type: "INT" }] });
    expect(splitProgram(joinProgram(program))).toEqual(result);
  });

  it("round trips a project through PLCopen XML", () => {
    const project: Project = {
      fileHeader: {
        companyName: "Test",
        productName: "benchtop-plc",
        productVersion: "0.0.0",
        creationDateTime: "2026-11-01T00:00:00Z",
      },
      contentHeader: { name: "Counter" },
      dataTypes: [],
      pous: [source],
      configuration: "Config",
      resource: "Res",
      task: { name: "Cyclic", interval: "PT0.01S", priority: 0 },
      instance: { name: "mainInstance", typeName: "Counter" },
      panel: null,
    };
    const written = writeProject(project);
    expect(written.diagnostics).toEqual([]);
    expect(written.value).toContain(`xmlns="${TC6_NAMESPACE}"`);
    expect(readProject(written.value!)).toEqual({ value: project, diagnostics: [] });
    expect(durationNanoseconds(project.task.interval)).toBe(10000000n);
    expect(readProject("<invalid/>").value).toBeNull();
  });
});

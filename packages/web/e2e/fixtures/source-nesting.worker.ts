import { compileProject, MAX_SOURCE_NESTING, MAX_SOURCE_TREE_DEPTH } from "@benchtop-plc/compiler";
import { readProject, writeProject } from "@benchtop-plc/project";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";
import {
  nestingCases,
  nestingProject,
  nestingSource,
  nestingBoundary,
  chainCases,
  chainProject,
  failedOperandsProject,
} from "../../../../tests/conformance/source-nesting.test-support.js";

// This harness deliberately runs all packages in Chromium's Worker, where stacks
// differ from Node and where the production runtime consumes compiler output.
self.onmessage = () => {
  try {
    const results = nestingCases.map((kind) => {
      const { limit } = nestingBoundary(kind);
      const source = nestingSource(kind, limit);
      const written = writeProject(nestingProject(source));
      if (!written.value) throw new Error(JSON.stringify(written.diagnostics));
      const read = readProject(written.value);
      if (!read.value) throw new Error(JSON.stringify(read.diagnostics));
      const compiled = compileProject(read.value.pous);
      if (!compiled.ir) throw new Error(JSON.stringify(compiled.diagnostics));
      const clock = new VirtualClock();
      const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
      runtime.load(compiled.ir);
      const snapshot = runtime.scanOnce();
      const index = compiled.ir.variables.findIndex((variable) => variable.name.endsWith(".x"));
      return {
        kind,
        preserved: read.value.pous[0] === source,
        diagnostics: compiled.diagnostics,
        fault: runtime.diagnostic,
        value: snapshot.variables[index],
        rejected: compileProject([nestingSource(kind, limit + 1)]).diagnostics.map(
          (diagnostic) => diagnostic.code,
        ),
      };
    });
    const failedOperands = (["calls", "comparisons"] as const).map((kind) => {
      const depth = kind === "calls" ? MAX_SOURCE_NESTING : MAX_SOURCE_NESTING / 2;
      const project = failedOperandsProject(kind, depth);
      const result = compileProject(project.pous, project.dataTypes);
      return {
        kind,
        bounded: result.diagnostics.length > 0 && result.diagnostics.length <= 2 * depth + 1,
      };
    });
    const chains = chainCases.map((kind) => {
      const project = chainProject(kind, MAX_SOURCE_TREE_DEPTH);
      const written = writeProject(project);
      if (!written.value) throw new Error(JSON.stringify(written.diagnostics));
      const read = readProject(written.value);
      if (!read.value) throw new Error(JSON.stringify(read.diagnostics));
      const compiled = compileProject(read.value.pous, read.value.dataTypes);
      if (!compiled.ir) throw new Error(JSON.stringify(compiled.diagnostics));
      const clock = new VirtualClock();
      const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
      runtime.load(compiled.ir);
      const snapshot = runtime.scanOnce();
      const index = compiled.ir.variables.findIndex((variable) =>
        variable.name.endsWith(kind === "or" ? ".b" : ".x"),
      );
      const rejected = chainProject(kind, MAX_SOURCE_TREE_DEPTH + 1);
      return {
        kind,
        preserved: read.value.pous[0] === project.pous[0],
        diagnostics: compiled.diagnostics,
        fault: runtime.diagnostic,
        value: snapshot.variables[index],
        rejected: compileProject(rejected.pous, rejected.dataTypes).diagnostics.map(
          (diagnostic) => diagnostic.code,
        ),
      };
    });
    self.postMessage({ results, failedOperands, chains });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};

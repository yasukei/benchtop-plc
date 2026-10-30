import { compileProject, MAX_SOURCE_NESTING } from "@benchtop-plc/compiler";
import { readProject, writeProject } from "@benchtop-plc/project";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";
import {
  nestingCases,
  nestingProject,
  nestingSource,
} from "../../../../tests/conformance/source-nesting.test-support.js";

// This harness deliberately runs all packages in Chromium's Worker, where stacks
// differ from Node and where the production runtime consumes compiler output.
self.onmessage = () => {
  try {
    const results = nestingCases.map((kind) => {
      const source = nestingSource(kind, MAX_SOURCE_NESTING);
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
        rejected: compileProject([nestingSource(kind, MAX_SOURCE_NESTING + 1)]).diagnostics.map(
          (diagnostic) => diagnostic.code,
        ),
      };
    });
    self.postMessage({ results });
  } catch (error) {
    self.postMessage({ error: String(error) });
  }
};

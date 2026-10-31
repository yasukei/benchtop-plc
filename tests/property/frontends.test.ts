import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileProject, lex, parse } from "@benchtop-plc/compiler";
import { readProject, writeProject } from "@benchtop-plc/project";
import {
  mutatedXml,
  nestingDepth,
  projectSources,
  sourceAtDepth,
  sourceCorpus,
  stSource,
  validProject,
  xmlCorpus,
  xmlFiles,
} from "./generators.js";

function integerOption(name: string, fallback: number, minimum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}: ${raw}`);
  return value;
}

// Leave headroom for V8 coverage and the full suite's parallel workers in CI.
const timeLimit = integerOption("FC_TIME_LIMIT_MS", 10000, 1);
const parameters = {
  // A fixed default also applies in CI; fast-check includes seed/path in every failure.
  seed: integerOption("FC_SEED", 246, -2147483648),
  numRuns: integerOption("FC_NUM_RUNS", 100, 1),
  ...(process.env.FC_PATH === undefined ? {} : { path: process.env.FC_PATH }),
  plugins: [fc.interruptAfterTimeLimit(timeLimit, { failOnInterrupt: true })],
};

describe("bounded frontend properties", () => {
  it("loads the conformance, example and fixture corpora", () => {
    expect(sourceCorpus.length).toBeGreaterThan(0);
    expect(xmlFiles.length).toBeGreaterThan(0);
    expect(xmlCorpus).toHaveLength(xmlFiles.length + 1);
  });

  for (const [name, frontend] of [
    ["lex", lex],
    ["parse", parse],
  ] as const) {
    it(
      `${name} returns a result or diagnostics for generated and mutated ST`,
      () => {
        fc.assert(
          fc.property(stSource, (source) => {
            const result = frontend(source);
            expect(Array.isArray(result.diagnostics)).toBe(true);
            if ("tokens" in result)
              expect(result.tokens !== null || result.diagnostics.length > 0).toBe(true);
            else expect(result.ast !== null || result.diagnostics.length > 0).toBe(true);
          }),
          parameters,
        );
      },
      timeLimit + 5000,
    );
  }

  it(
    "parse and compileProject never throw on generated nesting depths",
    () => {
      fc.assert(
        fc.property(nestingDepth, (depth) => {
          const source = sourceAtDepth(depth);
          expect(Array.isArray(parse(source).diagnostics)).toBe(true);
          expect(Array.isArray(compileProject([source]).diagnostics)).toBe(true);
        }),
        parameters,
      );
    },
    timeLimit + 5000,
  );

  it(
    "compileProject returns IR or diagnostics for generated and mutated ST projects",
    () => {
      fc.assert(
        fc.property(projectSources, (sources) => {
          const result = compileProject(
            sources.pous,
            sources.dataTypes,
            sources.configurationSource,
          );
          expect(Array.isArray(result.diagnostics)).toBe(true);
          expect(result.ir !== undefined || result.diagnostics.length > 0).toBe(true);
        }),
        parameters,
      );
    },
    timeLimit + 5000,
  );

  it(
    "readProject contains exceptions and returns a project or diagnostics for mutated XML",
    () => {
      fc.assert(
        fc.property(mutatedXml, (xml) => {
          const result = readProject(xml);
          expect(Array.isArray(result.diagnostics)).toBe(true);
          expect(result.value !== null || result.diagnostics.length > 0).toBe(true);
        }),
        parameters,
      );
    },
    timeLimit + 5000,
  );

  it(
    "writeProject/readProject round trips generated projects that compile",
    () => {
      fc.assert(
        fc.property(validProject, (project) => {
          const compiled = compileProject(
            project.pous,
            project.dataTypes,
            project.configurationSource,
          );
          expect(compiled.diagnostics).toEqual([]);
          expect(compiled.ir).toBeDefined();
          const written = writeProject(project);
          expect(written.diagnostics).toEqual([]);
          expect(written.value).not.toBeNull();
          const reopened = readProject(written.value!);
          expect(reopened).toEqual({ value: project, diagnostics: [] });
          const recompiled = compileProject(
            reopened.value!.pous,
            reopened.value!.dataTypes,
            reopened.value!.configurationSource,
          );
          expect(recompiled.diagnostics).toEqual([]);
          expect(recompiled.ir).toEqual(compiled.ir);
        }),
        parameters,
      );
    },
    timeLimit + 5000,
  );
});

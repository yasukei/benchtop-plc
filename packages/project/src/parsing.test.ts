import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDataType, parsePou, resolveNamespaces } from "@benchtop-plc/compiler";
import { readProject, writeProject, type Project } from "./index.js";

vi.mock("@benchtop-plc/compiler", async (importOriginal) => {
  const compiler = await importOriginal<typeof import("@benchtop-plc/compiler")>();
  return {
    ...compiler,
    parsePou: vi.fn(compiler.parsePou),
    parseDataType: vi.fn(compiler.parseDataType),
    resolveNamespaces: vi.fn(compiler.resolveNamespaces),
  };
});

afterEach(() => vi.clearAllMocks());

function project(blocks: number): Project {
  return {
    fileHeader: {
      companyName: "Test",
      productName: "benchtop-plc",
      productVersion: "0.8.0",
      creationDateTime: "2026-10-31T00:00:00Z",
    },
    contentHeader: { name: "Many POUs" },
    dataTypes: ["TYPE Count : INT; END_TYPE"],
    pous: [
      "// preserved program\nPROGRAM Main VAR block : Block0; END_VAR block(); END_PROGRAM",
      ...Array.from(
        { length: blocks },
        (_, i) =>
          `// preserved block ${i}\nFUNCTION_BLOCK Block${i} VAR_OUTPUT value : Count := ${i}; END_VAR ${"value := value + 1; ".repeat(40)}END_FUNCTION_BLOCK`,
      ),
    ],
    configuration: "Config",
    resource: "Res",
    task: { name: "Cyclic", interval: "PT0.01S", priority: 1 },
    instance: { name: "mainInstance", typeName: "Main" },
    panel: null,
  };
}

/** A separate legacy grammar is needed for old files with newly reserved identifiers. */
function parseCounts(): number {
  for (const parse of [parsePou, parseDataType]) {
    const calls = vi.mocked(parse).mock.calls;
    const keys = calls.map(([source, legacyNames]) => JSON.stringify([source, !!legacyNames]));
    expect(new Set(keys).size).toBe(keys.length);
  }
  return vi.mocked(parsePou).mock.calls.length + vi.mocked(parseDataType).mock.calls.length;
}

function expectSourcesParsedOnce(input: Project): void {
  for (const source of input.pous)
    expect(vi.mocked(parsePou).mock.calls.filter(([text]) => text === source)).toHaveLength(1);
  for (const source of input.dataTypes)
    expect(
      vi
        .mocked(parseDataType)
        .mock.calls.filter(([text]) => text === source && text.startsWith("TYPE")),
    ).toHaveLength(1);
}

function sourceWalkCount(): number {
  return vi
    .mocked(resolveNamespaces)
    .mock.calls.reduce((count, [sources]) => count + sources.length, 0);
}

describe("project source processing cost", () => {
  // Coverage instrumentation slows this large fixture; counts, not elapsed time, are the metric.
  it("scales linearly from 40 to 80 blocks, including save validation and preserved sources", () => {
    const counts = [40, 80].map((blocks) => {
      const input = project(blocks);
      vi.clearAllMocks();
      const saved = writeProject(input);
      expect(saved.diagnostics).toEqual([]);
      expect(saved.value).not.toBeNull();
      expectSourcesParsedOnce(input);
      const write = parseCounts();
      const writeWalks = sourceWalkCount();

      vi.clearAllMocks();
      const opened = readProject(saved.value!);
      expect(opened).toEqual({ value: input, diagnostics: [] });
      expectSourcesParsedOnce(input);
      const read = parseCounts();
      return { write, read, writeWalks, readWalks: sourceWalkCount() };
    });
    expect(counts[1]!.write).toBeLessThanOrEqual(2 * counts[0]!.write);
    expect(counts[1]!.read).toBeLessThanOrEqual(2 * counts[0]!.read);
    expect(counts[1]!.writeWalks).toBeLessThanOrEqual(2 * counts[0]!.writeWalks);
    expect(counts[1]!.readWalks).toBeLessThanOrEqual(2 * counts[0]!.readWalks);
  }, 30_000);

  it("starts a fresh cache on the next open or save", () => {
    const input = project(1);
    const saved = writeProject(input);
    expect(saved.diagnostics).toEqual([]);
    const write = parseCounts();
    writeProject(input);
    expect(vi.mocked(parsePou).mock.calls.length + vi.mocked(parseDataType).mock.calls.length).toBe(
      2 * write,
    );

    vi.clearAllMocks();
    readProject(saved.value!);
    const read = parseCounts();
    readProject(saved.value!);
    expect(vi.mocked(parsePou).mock.calls.length + vi.mocked(parseDataType).mock.calls.length).toBe(
      2 * read,
    );
  });
});

it("uses the standard base after rejecting stale preserved constants, regardless of POU order", () => {
  const input = project(0);
  input.dataTypes = [];
  const base =
    "NAMESPACE Lib FUNCTION_BLOCK Base VAR CONSTANT cap: INT := 2; END_VAR END_FUNCTION_BLOCK END_NAMESPACE";
  const derived =
    "NAMESPACE Lib FUNCTION_BLOCK Derived EXTENDS Base VAR items: ARRAY[1..cap] OF INT := [cap(1)]; END_VAR END_FUNCTION_BLOCK END_NAMESPACE";
  input.pous = ["PROGRAM Main VAR d: Lib.Derived; END_VAR END_PROGRAM", derived, base];
  const saved = writeProject(input);
  expect(saved.diagnostics).toEqual([]);
  const changed = saved.value!.replace("cap: INT := 2;", "cap: INT := 3;");
  expect(changed).not.toBe(saved.value);
  const opened = readProject(changed);
  expect(opened.diagnostics.map((d) => d.code)).toEqual(["project.stale-source"]);
  expect(opened.value!.pous.slice(0, 2)).toEqual(input.pous.slice(0, 2));
  expect(opened.value!.pous[2]).not.toBe(base);
  expect(opened.value!.pous[2]).toContain("cap : INT := 2;");
});

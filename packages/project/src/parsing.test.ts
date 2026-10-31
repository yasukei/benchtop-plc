import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDataType, parsePou } from "@benchtop-plc/compiler";
import { readProject, writeProject, type Project } from "./index.js";

vi.mock("@benchtop-plc/compiler", async (importOriginal) => {
  const compiler = await importOriginal<typeof import("@benchtop-plc/compiler")>();
  return {
    ...compiler,
    parsePou: vi.fn(compiler.parsePou),
    parseDataType: vi.fn(compiler.parseDataType),
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
          `// preserved block ${i}\nFUNCTION_BLOCK Block${i} VAR_OUTPUT value : Count := ${i}; END_VAR value := value + 1; END_FUNCTION_BLOCK`,
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

describe("project parsing cost", () => {
  it("scales linearly from 40 to 80 blocks, including save validation and preserved sources", () => {
    const counts = [40, 80].map((blocks) => {
      const input = project(blocks);
      vi.clearAllMocks();
      const saved = writeProject(input);
      expect(saved.diagnostics).toEqual([]);
      expect(saved.value).not.toBeNull();
      expectSourcesParsedOnce(input);
      const write = parseCounts();

      vi.clearAllMocks();
      const opened = readProject(saved.value!);
      expect(opened).toEqual({ value: input, diagnostics: [] });
      expectSourcesParsedOnce(input);
      const read = parseCounts();
      return { write, read };
    });
    expect(counts[1]!.write).toBeLessThanOrEqual(2 * counts[0]!.write);
    expect(counts[1]!.read).toBeLessThanOrEqual(2 * counts[0]!.read);
  });

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

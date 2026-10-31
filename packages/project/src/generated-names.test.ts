import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileProject,
  lex,
  parseConfiguration,
  parseDataType,
  parsePou,
} from "@benchtop-plc/compiler";
import { readProject, SOURCE_NAMESPACE, writeProject, type Project } from "./index.js";
import { splitConfiguration } from "./configuration.js";
import { ParsingContext } from "./parsing.js";

vi.mock("@benchtop-plc/compiler", async (importOriginal) => {
  const compiler = await importOriginal<typeof import("@benchtop-plc/compiler")>();
  return {
    ...compiler,
    parsePou: vi.fn(compiler.parsePou),
    parseDataType: vi.fn(compiler.parseDataType),
    parseConfiguration: vi.fn(compiler.parseConfiguration),
  };
});

afterEach(() => {
  // Assert the forthcoming identifier restriction independently of the lexer rules.
  // Fixtures use valid names, so this also covers every internal wrapper parsed by the codec.
  for (const parse of [parsePou, parseDataType, parseConfiguration]) {
    for (const [source] of vi.mocked(parse).mock.calls) {
      for (const token of lex(source).tokens ?? []) {
        if (token.kind === "identifier") expect(token.text, source).not.toMatch(/__|_$/);
      }
    }
  }
  vi.clearAllMocks();
});

function project(dataTypes: string[], pous: string[]): Project {
  return {
    fileHeader: {
      companyName: "Test",
      productName: "Test",
      productVersion: "0.8.0",
      creationDateTime: "2026-10-31T00:00:00Z",
    },
    contentHeader: { name: "Generated name collisions" },
    dataTypes,
    pous,
    configuration: "Config",
    resource: "Res",
    task: { name: "Cyclic", interval: "PT0.01S", priority: 1 },
    instance: { name: "mainInstance", typeName: "Instance" },
    panel: null,
  };
}

function save(value: Project): string {
  const written = writeProject(value);
  expect(written.diagnostics).toEqual([]);
  expect(written.value).not.toBeNull();
  return written.value!;
}

function withoutSource(xml: string): string {
  return xml.replace(
    new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"),
    "",
  );
}

function executable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(executable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "span")
      .map(([key, item]) => [key, executable(item)]),
  );
}

describe("generated ST identifiers", () => {
  it("round trips structures, arrays and references when user names match wrapper names", () => {
    const input = project(
      [
        "TYPE StructXml : INT; END_TYPE",
        "TYPE StructSource : STRUCT Value : StructXml; next : REF_TO StructSource; END_STRUCT; END_TYPE",
        "TYPE TypeSource : REF_TO StructSource; END_TYPE",
        "TYPE Value : ARRAY[1..2] OF TypeSource; END_TYPE",
        "TYPE Value1 : INT; END_TYPE",
      ],
      [
        `PROGRAM Instance
VAR CONSTANT Initial : INT := 2; END_VAR
VAR node : StructSource := (Value := 7); refs : Value := [NULL];
    counts : ARRAY[1..Initial] OF INT := [Initial(7)]; END_VAR
END_PROGRAM`,
        "FUNCTION_BLOCK TaskSource END_FUNCTION_BLOCK",
      ],
    );
    const original = compileProject(input.pous, input.dataTypes);
    expect(original.diagnostics).toEqual([]);
    const xml = save(input);
    expect(xml).toContain('<struct><variable name="Value">');
    expect(xml).toContain('<pointer><baseType><derived name="STRUCTSOURCE"/>');
    expect(xml).toContain('<array><dimension lower="1" upper="2"/>');
    expect(readProject(xml)).toEqual({ value: input, diagnostics: [] });

    const canonical = readProject(withoutSource(xml));
    expect(canonical.diagnostics).toEqual([]);
    const imported = compileProject(canonical.value!.pous, canonical.value!.dataTypes);
    expect(imported.diagnostics).toEqual([]);
    expect(executable(imported.ir)).toEqual(executable(original.ir));
    expect(readProject(save(canonical.value!))).toEqual(canonical);
  });

  it("preserves unresolved array types whose names collide with both wrapper names", () => {
    const input = project(
      ["TYPE TypeSource : ARRAY[1..2] OF Value := [UnknownValue]; END_TYPE"],
      ["PROGRAM Instance VAR items : TypeSource; END_VAR END_PROGRAM"],
    );
    const xml = save(input);
    expect(readProject(xml)).toEqual({ value: input, diagnostics: [] });
    const canonical = readProject(withoutSource(xml));
    expect(canonical.diagnostics).toEqual([]);
    expect(canonical.value!.dataTypes[0]).toContain("ARRAY[1..2] OF VALUE");
    expect(readProject(save(canonical.value!))).toEqual(canonical);
  });

  it("keeps grouped configuration globals and resource globals in their own scopes", () => {
    const input = project(
      ["TYPE Globals2 : INT; END_TYPE"],
      [
        `PROGRAM Instance
VAR_INPUT Value : BOOL; END_VAR
VAR_EXTERNAL CONSTANT Globals : INT; END_VAR
VAR_EXTERNAL configValue : INT; resourceValue : INT; END_VAR
VAR items : ARRAY[1..Globals] OF INT := [Globals(4)]; END_VAR
END_PROGRAM`,
      ],
    );
    input.configurationSource = `CONFIGURATION ConfigSource
VAR_GLOBAL CONSTANT gLoBaLs, Globals1 : INT := 2; END_VAR
VAR_GLOBAL configValue : INT := 7; END_VAR
RESOURCE ResourceSource ON Cpu
VAR_GLOBAL resourceValue, TaskSource : INT := 3; END_VAR
TASK TaskBinding (INTERVAL := T#10ms, PRIORITY := 0);
PROGRAM Inst WITH TaskBinding : Instance (Value := TRUE);
END_RESOURCE END_CONFIGURATION`;
    const original = compileProject(input.pous, input.dataTypes, input.configurationSource);
    expect(original.diagnostics).toEqual([]);
    const xml = save(input);
    expect(xml).toContain('<dimension lower="1" upper="2"/>');
    const [resourceXml, configurationXml] = xml
      .split('<resource name="ResourceSource">')[1]!
      .split("</resource>");
    expect(configurationXml).toContain('<variable name="gLoBaLs">');
    expect(configurationXml).toContain('<variable name="Globals1">');
    expect(configurationXml).toContain('<variable name="configValue">');
    expect(configurationXml).not.toContain('<variable name="resourceValue">');
    expect(resourceXml).toContain('<variable name="resourceValue">');
    expect(resourceXml).toContain('<variable name="TaskSource">');
    expect(resourceXml).not.toContain('<variable name="configValue">');

    for (const sourceXml of [xml, withoutSource(xml)]) {
      const opened = readProject(sourceXml);
      expect(opened.diagnostics).toEqual([]);
      const scope = splitConfiguration(new ParsingContext(), opened.value!.configurationSource!);
      expect(scope.globals?.map((variable) => variable.name)).toEqual([
        "gLoBaLs",
        "Globals1",
        "configValue",
      ]);
      expect(scope.resourceGlobals?.map((variable) => variable.name)).toEqual([
        "resourceValue",
        "TaskSource",
      ]);
      expect(
        compileProject(
          opened.value!.pous,
          opened.value!.dataTypes,
          opened.value!.configurationSource,
        ).diagnostics,
      ).toEqual([]);
      expect(readProject(save(opened.value!))).toEqual(opened);
    }
    expect(readProject(xml).value!.configurationSource).toBe(input.configurationSource);
  });
});

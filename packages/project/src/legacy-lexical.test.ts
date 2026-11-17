import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import {
  readProject,
  writeProject,
  splitProgram,
  SOURCE_NAMESPACE,
  type Project,
} from "./index.js";

const forms = [
  ["INT", "0", "LegacyName", "__d", "lex.invalid-identifier"],
  ["INT", "0", "LegacyName", "a__b", "lex.invalid-identifier"],
  ["INT", "0", "LegacyName", "c_", "lex.invalid-identifier"],
  ...[
    "Continue",
    "Action",
    "End_Action",
    "Initial_Step",
    "Step",
    "End_Step",
    "Transition",
    "End_Transition",
    "From",
    "R_Edge",
    "F_Edge",
    "Overlap",
  ].map((word) => ["INT", "0", "LegacyName", word, "syntax.reserved-identifier"] as const),
  ["REAL", "1.0E5", "1.0E5", "1E5", "lex.malformed-number"],
  ["INT", "INT#16#FF", "INT#16#FF", "INT#-16#FF", "lex.malformed-number"],
  ["TIME", "T#2h15m", "T#2h15m", "T#1h75m", "lex.malformed-number"],
] as const;

function projectWith(pous = ["PROGRAM Main END_PROGRAM"], dataTypes: string[] = []): Project {
  return {
    fileHeader: {
      companyName: "Test",
      productName: "Test",
      productVersion: "0.8.0",
      creationDateTime: "2026-10-31T00:00:00Z",
    },
    contentHeader: { name: "Legacy lexical forms" },
    pous,
    dataTypes,
    configuration: "Config",
    resource: "Res",
    task: { name: "Cyclic", interval: "PT0.01S", priority: 1 },
    instance: { name: "mainInstance", typeName: "Main" },
    panel: null,
  };
}

for (const extension of [true, false]) {
  for (const kind of ["pou", "dataType", "configuration"] as const) {
    it.each(forms)(
      `opens old ${kind} %s/%s/%s/%s source (extension: ${extension})`,
      (type, literal, original, legacy, code) => {
        const declaration = `LegacyName : ${type} := ${literal};`;
        const source =
          kind === "pou"
            ? `// keep exact source\r\nPROGRAM Main\r\nVAR ${declaration} END_VAR\r\nEND_PROGRAM`
            : kind === "dataType"
              ? `// keep exact source\r\nTYPE Saved : STRUCT ${declaration} END_STRUCT; END_TYPE`
              : `// keep exact source\r\nCONFIGURATION Config\r\nVAR_GLOBAL ${declaration} END_VAR
RESOURCE Res ON Cpu TASK Cyclic (INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM mainInstance WITH Cyclic : Main; END_RESOURCE END_CONFIGURATION`;
        const project: Project = {
          ...projectWith(
            [kind === "pou" ? source : "PROGRAM Main END_PROGRAM"],
            kind === "dataType" ? [source] : [],
          ),
          ...(kind === "configuration" ? { configurationSource: source } : {}),
        };
        const written = writeProject(project);
        expect(written.diagnostics).toEqual([]);
        // Recreate an older file in both standard XML and its exact-source extension.
        let xml = written.value!.replaceAll(original, legacy);
        expect(xml).not.toBe(written.value);
        if (!extension)
          xml = xml.replace(
            new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"),
            "",
          );
        const opened = readProject(xml);
        expect(opened.diagnostics).toEqual([]);
        expect(opened.value).not.toBeNull();
        const restored =
          kind === "pou"
            ? opened.value!.pous[0]
            : kind === "dataType"
              ? opened.value!.dataTypes[0]
              : opened.value!.configurationSource;
        if (extension) expect(restored).toBe(source.replaceAll(original, legacy));
        else expect(restored).toContain(legacy);
        const compiled = compileProject(
          opened.value!.pous,
          opened.value!.dataTypes,
          opened.value!.configurationSource,
        );
        expect(compiled.ir).toBeUndefined();
        expect(compiled.diagnostics).toContainEqual(expect.objectContaining({ code }));
        expect(writeProject(opened.value!).value).toBeNull();
      },
    );
  }
}

it("opens an old POU name also used by its configured instance", () => {
  const written = writeProject(projectWith());
  expect(written.diagnostics).toEqual([]);
  const opened = readProject(written.value!.replaceAll("Main", "__main"));
  expect(opened.diagnostics).toEqual([]);
  expect(opened.value?.pous).toEqual(["PROGRAM __main END_PROGRAM"]);
  expect(opened.value?.instance?.typeName).toBe("__main");
});

it("keeps unknown legacy array element names exchangeable", () => {
  const source = "TYPE Saved : ARRAY[1..2] OF UnknownElement; END_TYPE";
  const written = writeProject(projectWith(undefined, [source]));
  expect(written.diagnostics).toEqual([]);
  const opened = readProject(
    written
      .value!.replaceAll("UnknownElement", "__unknown")
      .replaceAll("UNKNOWNELEMENT", "__UNKNOWN"),
  );
  expect(opened.diagnostics).toEqual([]);
  expect(opened.value?.dataTypes).toEqual([source.replace("UnknownElement", "__unknown")]);
});

it("folds repetition counts that reference legacy constant names", () => {
  const source =
    "PROGRAM Main VAR CONSTANT __count : INT := 2; END_VAR VAR values : ARRAY[1..2] OF INT := [__count(1)]; END_VAR END_PROGRAM";
  const result = splitProgram(source, [], undefined, true);
  expect(result.diagnostics).toEqual([]);
  expect(result.value?.variables).toContainEqual(
    expect.objectContaining({ name: "values", initialValue: "[2(1)]" }),
  );
});

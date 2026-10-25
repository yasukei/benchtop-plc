import { expect, it } from "vitest";
import { compileProject, parsePou, parseDataType } from "@benchtop-plc/compiler";
import { readProject, writeProject, SOURCE_NAMESPACE } from "./index.js";
import { sampleProject } from "./codec.test.js";

const sources = [
  "NAMESPACE Plant\nUSING Devices;\nPROGRAM Main VAR drive: Motor; total: Count; END_VAR drive.Run(); total := drive.speed; END_PROGRAM\nEND_NAMESPACE",
  "NAMESPACE Devices\nCLASS INTERNAL Motor VAR PUBLIC speed: INT; END_VAR METHOD PUBLIC Run speed := speed + 1; END_METHOD END_CLASS\nEND_NAMESPACE",
];
const types = ["NAMESPACE Devices\nTYPE Count : INT; END_TYPE\nEND_NAMESPACE"];
const configuration =
  "CONFIGURATION C RESOURCE R ON Cpu TASK T (INTERVAL := T#10ms, PRIORITY := 0); PROGRAM P WITH T : Plant.Main; END_RESOURCE END_CONFIGURATION";

it("round trips namespace wrappers and imports with qualified standard XML names", () => {
  const project = sampleProject(sources[0]!);
  project.pous = sources.map((source) => source.replace("CLASS INTERNAL", "CLASS"));
  project.dataTypes = types;
  project.configurationSource = configuration;
  project.configuration = "C";
  project.resource = "R";
  project.task.name = "T";
  project.instance = { name: "P", typeName: "Plant.Main" };
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  expect(saved.value).toContain('pou name="Plant.Main"');
  expect(saved.value).toContain('pou name="Devices.Motor"');
  expect(saved.value).toContain('dataType name="Devices.Count"');
  expect(saved.value).toContain('derived name="DEVICES.MOTOR"');
  expect(saved.value).toContain('derived name="DEVICES.COUNT"');
  expect(saved.value).toContain('typeName="Plant.Main"');
  const opened = readProject(saved.value!);
  expect(opened.diagnostics).toEqual([]);
  expect(opened.value).toEqual(project);
  expect(
    compileProject(opened.value!.pous, opened.value!.dataTypes, opened.value!.configurationSource)
      .diagnostics,
  ).toEqual([]);
});

it("generates namespace wrappers without source extensions", () => {
  const project = sampleProject(
    "NAMESPACE Lib\nPROGRAM Main VAR n: Lib.Count; END_VAR n := n + 1; END_PROGRAM\nEND_NAMESPACE",
  );
  project.dataTypes = ["NAMESPACE Lib\nTYPE Count : INT; END_TYPE\nEND_NAMESPACE"];
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  const standard = saved.value!.replace(
    new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"),
    "",
  );
  const opened = readProject(standard);
  expect(opened.diagnostics).toEqual([]);
  expect(parsePou(opened.value!.pous[0]!).ast?.name.name).toBe("Lib.Main");
  expect(parseDataType(opened.value!.dataTypes[0]!).ast?.name.name).toBe("Lib.Count");
  expect(compileProject(opened.value!.pous, opened.value!.dataTypes).diagnostics).toEqual([]);
});

it("preserves INTERNAL declarations and imported data type aliases", () => {
  const project = sampleProject("PROGRAM Main END_PROGRAM");
  project.pous.push(...sources.slice(1));
  project.dataTypes = [
    ...types,
    "NAMESPACE Plant\nUSING Devices;\nTYPE INTERNAL Counter : Count; END_TYPE\nEND_NAMESPACE",
  ];
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  expect(saved.value).toContain('derived name="DEVICES.COUNT"');
  expect(readProject(saved.value!)).toEqual({ value: project, diagnostics: [] });
});

it("qualifies imported references, structure members and array elements in data types", () => {
  const project = sampleProject("PROGRAM Main END_PROGRAM");
  project.dataTypes = [
    ...types,
    "NAMESPACE Plant USING Devices; TYPE Link : REF_TO Count; END_TYPE END_NAMESPACE",
    "NAMESPACE Plant USING Devices; TYPE RecordType : STRUCT countValue: Count; nextValue: REF_TO Count; END_STRUCT; END_TYPE END_NAMESPACE",
    "NAMESPACE Plant USING Devices; TYPE Counts : ARRAY[1..2] OF Count; END_TYPE END_NAMESPACE",
  ];
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  expect(saved.value).not.toBeNull();
  expect(readProject(saved.value!)).toEqual({ value: project, diagnostics: [] });
});

it("preserves bounds using constants from a base imported by USING", () => {
  const project = sampleProject("PROGRAM Main END_PROGRAM");
  project.pous.push(
    "NAMESPACE Machine USING Lib; CLASS Derived EXTENDS Base VAR items: ARRAY[1..maxCount] OF INT; END_VAR END_CLASS END_NAMESPACE",
    "NAMESPACE Lib CLASS Base VAR PROTECTED CONSTANT maxCount: INT := 3; END_VAR END_CLASS END_NAMESPACE",
  );
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  expect(saved.value).not.toBeNull();
  expect(readProject(saved.value!)).toEqual({ value: project, diagnostics: [] });
});

it.each([true, false])(
  "opens old namespace-keyword identifier drafts (extension: %s)",
  (extension) => {
    for (const word of ["Namespace", "End_Namespace", "Using"]) {
      const text = "PROGRAM Main\nVAR Legacy: INT; END_VAR\nLegacy := 42;\nEND_PROGRAM";
      let xml = writeProject(sampleProject(text)).value!.replaceAll("Legacy", word);
      if (!extension)
        xml = xml.replace(
          new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"),
          "",
        );
      const opened = readProject(xml);
      expect(opened.diagnostics).toEqual([]);
      expect(opened.value?.pous[0]).toContain(word);
      if (extension) expect(opened.value?.pous[0]).toBe(text.replaceAll("Legacy", word));
      expect(parsePou(opened.value!.pous[0]!).ast).toBeNull();
      expect(writeProject(opened.value!).value).toBeNull();
    }
  },
);

it.each([true, false])(
  "qualifies imported interface aliases and instance reference targets (extension: %s)",
  (extension) => {
    const project = sampleProject(
      "PROGRAM Main VAR v: Plant.InterfaceAlias; r: Plant.MotorRef; END_VAR END_PROGRAM",
    );
    project.pous.unshift("NAMESPACE Lib INTERFACE I END_INTERFACE END_NAMESPACE");
    project.pous.push("NAMESPACE Lib CLASS Motor END_CLASS END_NAMESPACE");
    project.dataTypes = [
      "NAMESPACE Plant USING Lib; TYPE InterfaceAlias : I; END_TYPE END_NAMESPACE",
      "NAMESPACE Plant USING Lib; TYPE MotorRef : REF_TO Motor; END_TYPE END_NAMESPACE",
    ];
    expect(compileProject(project.pous, project.dataTypes).diagnostics).toEqual([]);
    const saved = writeProject(project);
    expect(saved.diagnostics).toEqual([]);
    expect(saved.value).toContain('derived name="LIB.I"');
    expect(saved.value).toContain('derived name="LIB.MOTOR"');
    const xml = extension
      ? saved.value!
      : saved.value!.replace(
          new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"),
          "",
        );
    const opened = readProject(xml);
    expect(opened.diagnostics).toEqual([]);
    if (extension) expect(opened.value).toEqual(project);
    expect(compileProject(opened.value!.pous, opened.value!.dataTypes).diagnostics).toEqual([]);
  },
);

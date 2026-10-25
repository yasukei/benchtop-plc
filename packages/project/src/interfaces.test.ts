import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { readProject, writeProject, INTERFACE_NAMESPACE, SOURCE_NAMESPACE } from "./index.js";
import { sampleProject } from "./codec.test.js";
const face = "INTERFACE IActuator\n(* exact prototype *)\nMETHOD Start END_METHOD\nEND_INTERFACE";
const main = "PROGRAM Main VAR a: IActuator; v: Valve; END_VAR a := v; a.Start(); END_PROGRAM";
const valve = "CLASS Valve IMPLEMENTS IActuator METHOD PUBLIC Start END_METHOD END_CLASS";

it("round trips interface sources in the versioned root record", () => {
  const project = sampleProject(main);
  project.pous = [face, main, valve];
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  expect(saved.value).toContain(`name="${INTERFACE_NAMESPACE}" handleUnknown="discard"`);
  expect(saved.value).toContain('version="1"><source>INTERFACE IActuator');
  expect(saved.value).not.toContain('pou name="IActuator"');
  const opened = readProject(saved.value!);
  expect(opened.diagnostics).toEqual([]);
  expect(opened.value).toEqual(project);
  expect(compileProject(opened.value!.pous).diagnostics).toEqual([]);
});

it("opens without the interface record and reports unknown interface-typed variables", () => {
  const project = sampleProject(main);
  project.pous = [face, main, valve];
  const xml = writeProject(project).value!;
  const stripped = xml.replace(
    new RegExp(`<data name="${INTERFACE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`),
    "",
  );
  const opened = readProject(stripped);
  expect(opened.value).not.toBeNull();
  expect(compileProject(opened.value!.pous).diagnostics.map((d) => d.code)).toContain(
    "decl.unknown-type",
  );
});

it.each([
  ['version="1"><source>INTERFACE', 'version="2"><source>INTERFACE'],
  ["<source>INTERFACE", '<source bad="1">INTERFACE'],
  ["END_INTERFACE</source>", "END_INTERFACE</source><bad/>"],
])("rejects malformed interface records", (from, to) => {
  const project = sampleProject(main);
  project.pous = [face, main, valve];
  const xml = writeProject(project).value!;
  expect(readProject(xml.replace(from, to)).value).toBeNull();
});

it.each(["Interface", "End_Interface", "Implements"])("opens legacy identifier %s", (word) => {
  const project = sampleProject("PROGRAM Main VAR Legacy: INT; END_VAR Legacy := 1; END_PROGRAM");
  const xml = writeProject(project).value!.replaceAll("Legacy", word);
  for (const source of [
    xml,
    xml.replace(new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"), ""),
  ]) {
    const opened = readProject(source);
    expect(opened.diagnostics).toEqual([]);
    expect(opened.value?.pous[0]).toContain(word);
  }
});

it("round trips interface leaves in named structures and arrays", () => {
  const project = sampleProject("PROGRAM Main VAR record: Holder; END_VAR END_PROGRAM");
  project.pous.unshift(face);
  project.dataTypes.push(
    "TYPE Holder : STRUCT link: IActuator := NULL; links: ARRAY[1..2] OF IActuator; END_STRUCT; END_TYPE",
  );
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  const opened = readProject(saved.value!);
  expect(opened.diagnostics).toEqual([]);
  expect(opened.value).toEqual(project);
  expect(compileProject(opened.value!.pous, opened.value!.dataTypes).diagnostics).toEqual([]);
});

it("does not accept an interface source extension in place of a standard POU", () => {
  const project = sampleProject("PROGRAM Main END_PROGRAM");
  project.pous.push("FUNCTION_BLOCK Device END_FUNCTION_BLOCK");
  const xml = writeProject(project).value!.replace(
    "FUNCTION_BLOCK Device END_FUNCTION_BLOCK</source:source>",
    "INTERFACE Device END_INTERFACE</source:source>",
  );
  expect(xml).toContain("INTERFACE Device");
  const opened = readProject(xml);
  expect(opened.diagnostics.map((d) => d.code)).toContain("project.stale-source");
  expect(opened.value?.pous[1]).toContain("FUNCTION_BLOCK Device");
});

it("preserves configured PROGRAM interface in-out bindings on save and reopen", () => {
  const project = sampleProject("PROGRAM Main VAR_IN_OUT a: IActuator; END_VAR END_PROGRAM");
  delete project.instance;
  project.pous.unshift(face);
  project.configurationSource = `CONFIGURATION Config VAR_GLOBAL shared: IActuator; END_VAR
  RESOURCE Res ON BENCHTOP TASK Cyclic(INTERVAL := T#10ms, PRIORITY := 0);
  PROGRAM mainInstance WITH Cyclic: Main(a := shared); END_RESOURCE END_CONFIGURATION`;
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  const opened = readProject(saved.value!);
  expect(opened.diagnostics).toEqual([]);
  expect(opened.value).toEqual(project);
  expect(
    compileProject(opened.value!.pous, opened.value!.dataTypes, opened.value!.configurationSource)
      .diagnostics,
  ).toEqual([]);
});

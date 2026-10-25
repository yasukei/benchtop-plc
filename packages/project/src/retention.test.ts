import { expect, it } from "vitest";
import { readProject, writeProject, SOURCE_NAMESPACE, type Project } from "./index.js";
import { compileProject } from "@benchtop-plc/compiler";

const project: Project = {
  fileHeader: {
    companyName: "Test",
    productName: "Test",
    productVersion: "0.5.0",
    creationDateTime: "2026-10-25T00:00:00Z",
  },
  contentHeader: { name: "Retention" },
  configuration: "C",
  resource: "R",
  task: { name: "T", interval: "PT0.01S", priority: 0 },
  panel: null,
  dataTypes: [],
  configurationSource: `CONFIGURATION C VAR_GLOBAL RETAIN globalKept : INT; END_VAR RESOURCE R ON Cpu VAR_GLOBAL NON_RETAIN globalReset : INT; END_VAR TASK T (INTERVAL := T#10ms, PRIORITY := 0); PROGRAM A WITH T : P; END_RESOURCE END_CONFIGURATION`,
  pous: [
    `PROGRAM P VAR RETAIN kept : INT; END_VAR VAR NON_RETAIN reset : INT; END_VAR VAR_INPUT RETAIN input : INT; END_VAR VAR_OUTPUT NON_RETAIN output : INT; END_VAR VAR plain : INT; END_VAR END_PROGRAM`,
    `FUNCTION_BLOCK B VAR RETAIN kept : INT; END_VAR VAR NON_RETAIN reset : INT; END_VAR END_FUNCTION_BLOCK`,
  ],
};

it("round trips retain/nonretain on TC6 POU and global variable lists with exact source", () => {
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  expect(saved.value).toContain('<localVars retain="true">');
  expect(saved.value).toContain('<localVars nonretain="true">');
  expect(saved.value).toContain('<inputVars retain="true">');
  expect(saved.value).toContain('<outputVars nonretain="true">');
  expect(saved.value).toContain('<globalVars retain="true">');
  expect(saved.value).toContain('<globalVars nonretain="true">');
  const opened = readProject(saved.value!);
  expect(opened.diagnostics).toEqual([]);
  expect(opened.value?.pous).toEqual(project.pous);
  expect(opened.value?.configurationSource).toBe(project.configurationSource);
});

it("generates matching qualified sources when importing TC6 without source extensions", () => {
  const xml = writeProject(project).value!.replace(
    new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"),
    "",
  );
  const opened = readProject(xml);
  expect(opened.diagnostics).toEqual([]);
  expect(opened.value!.pous[0]).toContain("VAR RETAIN");
  expect(opened.value!.pous[0]).toContain("VAR NON_RETAIN");
  expect(opened.value!.configurationSource).toContain("VAR_GLOBAL RETAIN");
  expect(opened.value!.configurationSource).toContain("VAR_GLOBAL NON_RETAIN");
  expect(
    compileProject(opened.value!.pous, [], opened.value!.configurationSource).diagnostics,
  ).toEqual([]);
  expect(readProject(writeProject(opened.value!).value!).value!.pous).toEqual(opened.value!.pous);
});

it("validates XML booleans and detects stale retention qualifiers in source extensions", () => {
  const xml = writeProject(project).value!;
  expect(readProject(xml.replace('retain="true"', 'retain="invalid"')).diagnostics).toContainEqual(
    expect.objectContaining({ code: "project.invalid" }),
  );
  expect(
    readProject(xml.replace('<globalVars retain="true">', '<globalVars nonretain="true">'))
      .diagnostics,
  ).toContainEqual(expect.objectContaining({ code: "project.stale-source" }));
});

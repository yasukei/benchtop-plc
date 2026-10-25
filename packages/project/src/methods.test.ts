import { expect, it } from "vitest";
import { compileProject, parsePou, parseDataType } from "@benchtop-plc/compiler";
import { readProject, writeProject, SOURCE_NAMESPACE } from "./index.js";
import { sampleProject } from "./codec.test.js";

const counter = `FUNCTION_BLOCK Counter
VAR PRIVATE n: INT; END_VAR
METHOD PUBLIC Increment n := n + 1; END_METHOD
METHOD PUBLIC Value : INT Value := n; END_METHOD
Increment();
END_FUNCTION_BLOCK`;

it("round trips exact methods and access specifiers while exposing only the block in standard XML", () => {
  const project = sampleProject(
    "PROGRAM Main VAR c: Counter; x: INT; END_VAR c.Increment(); x := c.Value(); END_PROGRAM",
  );
  project.pous.push(counter);
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  expect(readProject(saved.value!).value).toEqual(project);
  const standard = saved.value!.replace(
    new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"),
    "",
  );
  expect(standard).not.toContain("METHOD");
  expect(readProject(standard).value?.pous[1]).toContain("Increment();");
  expect(compileProject(project.pous).diagnostics).toEqual([]);
});

it.each([true, false])(
  "opens reserved variable names as drafts (source extension: %s)",
  (preserved) => {
    const text =
      "PROGRAM Main\n(* preserved spacing *)\nVAR Legacy: INT; END_VAR\nLegacy := Legacy + 1;\nEND_PROGRAM";
    let xml = writeProject(sampleProject(text)).value!.replaceAll("Legacy", "Public");
    if (!preserved)
      xml = xml.replace(
        new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"),
        "",
      );
    const opened = readProject(xml);
    expect(opened.diagnostics).toEqual([]);
    expect(opened.value).not.toBeNull();
    const source = opened.value!.pous[0]!;
    if (preserved) expect(source).toBe(text.replaceAll("Legacy", "Public"));
    expect(source).toContain("Public");
    expect(parsePou(source).ast).toBeNull();
    expect(writeProject(opened.value!).value).toBeNull();
  },
);

it("keeps configuration resource types and parameter connections in a draft", () => {
  const project = sampleProject("PROGRAM Main VAR_INPUT Start: BOOL; END_VAR END_PROGRAM");
  project.configurationSource = `CONFIGURATION Plant RESOURCE Station ON Cpu
TASK T (INTERVAL := T#10ms, PRIORITY := 0);
PROGRAM A WITH T : Main (Start := TRUE);
END_RESOURCE END_CONFIGURATION`;
  const xml = writeProject(project).value!.replaceAll("ON Cpu", "ON Internal");
  const opened = readProject(xml);
  expect(opened.diagnostics).toEqual([]);
  expect(opened.value?.configurationSource).toBe(
    project.configurationSource.replace("ON Cpu", "ON Internal"),
  );
});

it("opens a reserved enum value as a draft without changing referring POU text", () => {
  const text = "PROGRAM Main\nVAR state: State; END_VAR\nstate := State#Legacy;\nEND_PROGRAM";
  const project = sampleProject(text);
  project.dataTypes = ["TYPE State : (Idle, Legacy); END_TYPE"];
  const xml = writeProject(project).value!.replaceAll("Legacy", "Private");
  const opened = readProject(xml);
  expect(opened.diagnostics).toEqual([]);
  expect(opened.value?.pous).toEqual([text.replaceAll("Legacy", "Private")]);
  expect(opened.value?.dataTypes).toEqual(["TYPE State : (Idle, Private); END_TYPE"]);
  expect(parseDataType(opened.value!.dataTypes[0]!).ast).toBeNull();
});

it.each([false, true])(
  "opens generated reserved configuration names as drafts (multiple tasks: %s)",
  (multiple) => {
    const project = sampleProject("PROGRAM Main END_PROGRAM");
    project.configurationSource = `CONFIGURATION Plant RESOURCE R ON Cpu
  TASK T (INTERVAL := T#10ms, PRIORITY := 0);
  ${multiple ? "TASK Slow (INTERVAL := T#20ms, PRIORITY := 1);" : ""}
  PROGRAM P WITH T : Main;
  END_RESOURCE END_CONFIGURATION`;
    const xml = writeProject(project)
      .value!.replace(
        new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"),
        "",
      )
      .replaceAll("Plant", "Public");
    const result = readProject(xml);
    expect(result.diagnostics).toEqual([]);
    expect(result.value?.configurationSource).toContain("CONFIGURATION Public");
    expect(writeProject(result.value!).value).toBeNull();
  },
);

it("preserves a semicolon after END_METHOD without adding it to the standard body", () => {
  const project = sampleProject("PROGRAM Main END_PROGRAM");
  project.pous.push("FUNCTION_BLOCK Block METHOD PUBLIC M END_METHOD; M(); END_FUNCTION_BLOCK");
  const xml = writeProject(project);
  expect(xml.diagnostics).toEqual([]);
  expect(readProject(xml.value!).value).toEqual(project);
});

it("does not let a reserved-name draft hide an out-of-range type initializer", () => {
  const project = sampleProject("PROGRAM Main END_PROGRAM");
  project.dataTypes = ["TYPE Legacy : INT := 1; END_TYPE"];
  const xml = writeProject(project)
    .value!.replaceAll("Legacy", "Public")
    .replace('value="1"', 'value="40000"');
  expect(readProject(xml).value).toBeNull();
});

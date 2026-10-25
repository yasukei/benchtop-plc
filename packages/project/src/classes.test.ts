import { expect, it } from "vitest";
import { compileProject, parsePou } from "@benchtop-plc/compiler";
import { readProject, writeProject, SOURCE_NAMESPACE } from "./index.js";
import { sampleProject } from "./codec.test.js";

const valve = `CLASS Valve
(* exact class source *)
VAR PUBLIC RETAIN Position: INT := 5; END_VAR
VAR PRIVATE opened: BOOL; END_VAR
METHOD PUBLIC Open THIS.opened := TRUE; Position := 100; END_METHOD
METHOD PUBLIC IsOpen : BOOL IsOpen := opened; END_METHOD
END_CLASS`;
const stripSource = (xml: string) =>
  xml.replace(new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"), "");

it("round trips classes, methods, qualifiers and arrays with exact source text", () => {
  const project = sampleProject(
    "PROGRAM Main VAR valves: ARRAY[1..2] OF Valve; seen: BOOL; END_VAR valves[1].Open(); seen := valves[1].IsOpen(); END_PROGRAM",
  );
  project.pous.push(valve);
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  expect(saved.value).toContain('pou name="Valve" pouType="functionBlock"');
  const opened = readProject(saved.value!);
  expect(opened.diagnostics).toEqual([]);
  expect(opened.value).toEqual(project);
  expect(compileProject(opened.value!.pous).diagnostics).toEqual([]);
  const standard = readProject(stripSource(saved.value!));
  expect(standard.diagnostics).toEqual([]);
  expect(parsePou(standard.value!.pous[1]!).ast).toMatchObject({
    kind: "functionBlock",
    body: [],
    declarations: [{ retain: true }, {}],
  });
});

it("does not accept a class source when the standard function block body has statements", () => {
  const project = sampleProject("PROGRAM Main END_PROGRAM");
  project.pous.push(valve);
  const xml = writeProject(project).value!;
  const changed = xml.replace(
    /(<pou name="Valve"[\s\S]*?<ST>)<xhtml:p\/>/,
    "$1<xhtml:p>Position := 3;</xhtml:p>",
  );
  expect(changed).not.toBe(xml);
  const opened = readProject(changed);
  expect(opened.diagnostics.map((d) => d.code)).toContain("project.stale-source");
  expect(opened.value?.pous[1]).toContain("Position := 3;");
  expect(opened.value?.pous[1]).toContain("FUNCTION_BLOCK Valve");
});

it.each([true, false])(
  "opens CLASS and END_CLASS identifier drafts (source extension: %s)",
  (extension) => {
    for (const word of ["Class", "End_Class"]) {
      const text =
        "PROGRAM Main\n(* preserve me *)\nVAR Legacy: INT; END_VAR\nLegacy := 42;\nEND_PROGRAM";
      let xml = writeProject(sampleProject(text)).value!.replaceAll("Legacy", word);
      if (!extension) xml = stripSource(xml);
      const opened = readProject(xml);
      expect(opened.diagnostics).toEqual([]);
      expect(opened.value?.pous[0]).toContain(word);
      if (extension) expect(opened.value?.pous[0]).toBe(text.replaceAll("Legacy", word));
      expect(parsePou(opened.value!.pous[0]!).ast).toBeNull();
      expect(writeProject(opened.value!).value).toBeNull();
    }
  },
);

it("matches a class source against a whitespace-only standard body", () => {
  const project = sampleProject("PROGRAM Main END_PROGRAM");
  project.pous.push(valve);
  const xml = writeProject(project).value!.replace(
    /(<pou name="Valve"[\s\S]*?<ST>)<xhtml:p\/>/,
    "$1<xhtml:p>\n  \n</xhtml:p>",
  );
  expect(readProject(xml)).toEqual({ value: project, diagnostics: [] });
});

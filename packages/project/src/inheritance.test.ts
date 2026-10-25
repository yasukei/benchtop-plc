import { expect, it } from "vitest";
import { compileProject, parseDataType, parsePou } from "@benchtop-plc/compiler";
import { readProject, writeProject, SOURCE_NAMESPACE } from "./index.js";
import { sampleProject } from "./codec.test.js";

const stripSource = (xml: string) =>
  xml.replace(new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"), "");
const block = `FUNCTION_BLOCK Base
VAR_INPUT Step: INT := 1; END_VAR
VAR_OUTPUT Count: INT; END_VAR
METHOD PUBLIC Tick Count := Count + Step; END_METHOD
Tick();
END_FUNCTION_BLOCK`;

it("round trips exact inheritance sources and writes only declared variables to standard elements", () => {
  const project = sampleProject(
    "PROGRAM Main VAR d: Derived; servo1: Servo; END_VAR d(); servo1.Run(); END_PROGRAM",
  );
  project.pous.push(
    block,
    "FUNCTION_BLOCK FINAL Derived EXTENDS Base VAR own: INT := 3; END_VAR SUPER(); own := own + 1; END_FUNCTION_BLOCK",
    "CLASS ABSTRACT Motor VAR PROTECTED Speed: INT; END_VAR METHOD PUBLIC ABSTRACT Run END_METHOD END_CLASS",
    "CLASS Servo EXTENDS Motor METHOD PUBLIC FINAL OVERRIDE Run Speed := Speed + 1; END_METHOD END_CLASS",
  );
  expect(compileProject(project.pous).diagnostics).toEqual([]);
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  const opened = readProject(saved.value!);
  expect(opened.diagnostics).toEqual([]);
  expect(opened.value).toEqual(project);
  expect(compileProject(opened.value!.pous).ir).toEqual(compileProject(project.pous).ir);
  const standard = readProject(stripSource(saved.value!));
  expect(standard.diagnostics).toEqual([]);
  const derived = parsePou(standard.value!.pous[2]!).ast!;
  expect(derived.declarations.flatMap((d) => d.names.map((n) => n.name))).toEqual(["own"]);
  expect(derived.body).toMatchObject([
    { kind: "fbCall", instance: { name: "SUPER" } },
    { kind: "assignment" },
  ]);
});

it.each(["", "(* inherit the base body *)", "RETURN;", "SUPER();"])(
  "excludes EXTENDS from a derived block's standard body: %s",
  (body) => {
    const project = sampleProject("PROGRAM Main VAR d: Derived; END_VAR d(); END_PROGRAM");
    project.pous.push(block, `FUNCTION_BLOCK Derived EXTENDS Base ${body} END_FUNCTION_BLOCK`);
    const saved = writeProject(project);
    expect(saved.diagnostics).toEqual([]);
    expect(readProject(saved.value!)).toEqual({ value: project, diagnostics: [] });
    const standard = readProject(stripSource(saved.value!));
    expect(parsePou(standard.value!.pous[2]!).ast?.body).toHaveLength(
      body === "RETURN;" || body === "SUPER();" ? 1 : 0,
    );
  },
);

it("ignores inheritance modifiers when comparing preserved and standard sources", () => {
  const project = sampleProject("PROGRAM Main END_PROGRAM");
  project.pous.push("FUNCTION_BLOCK Derived VAR n: INT; END_VAR END_FUNCTION_BLOCK");
  const xml = writeProject(project).value!;
  // Change only preserved text: TC6 intentionally carries no inheritance metadata.
  const changed = xml.replace(
    "FUNCTION_BLOCK Derived",
    "FUNCTION_BLOCK FINAL Derived EXTENDS Base",
  );
  expect(changed).not.toBe(xml);
  expect(readProject(changed).diagnostics).toEqual([]);
  expect(readProject(changed).value?.pous[1]).toContain("FINAL Derived EXTENDS Base");
});

it.each([true, false])(
  "opens newly reserved names as drafts (source extension: %s)",
  (extension) => {
    for (const word of ["Extends", "Override", "Super", "Abstract", "Final"]) {
      const source =
        "PROGRAM Main\n(* keep exact text *)\nVAR Legacy: INT; END_VAR\nLegacy := 3;\nEND_PROGRAM";
      let xml = writeProject(sampleProject(source)).value!.replaceAll("Legacy", word);
      if (!extension) xml = stripSource(xml);
      const result = readProject(xml);
      expect(result.diagnostics).toEqual([]);
      if (extension) expect(result.value?.pous[0]).toBe(source.replaceAll("Legacy", word));
      expect(parsePou(result.value!.pous[0]!).ast).toBeNull();
      expect(writeProject(result.value!).value).toBeNull();
    }
  },
);

it("preserves a newly reserved enumeration value and referring POU as drafts", () => {
  const project = sampleProject(
    "PROGRAM Main VAR state: State; END_VAR state := State#Legacy; END_PROGRAM",
  );
  project.dataTypes = ["TYPE State: (Idle, Legacy); END_TYPE"];
  const xml = writeProject(project).value!.replaceAll("Legacy", "Final");
  const result = readProject(xml);
  expect(result.diagnostics).toEqual([]);
  expect(parseDataType(result.value!.dataTypes[0]!).ast).toBeNull();
  expect(result.value?.pous[0]).toBe(project.pous[0]!.replaceAll("Legacy", "Final"));
});

it("round trips forward, transitive inherited constants in bounds and repetition counts", () => {
  const project = sampleProject("PROGRAM Main VAR d: Derived; END_VAR END_PROGRAM");
  project.pous.push(
    `FUNCTION_BLOCK Derived EXTENDS Middle
    VAR CONSTANT top: INT := cap + 1; END_VAR
    VAR items: ARRAY[1..cap] OF INT := [cap(1)]; limits: INT(0..top); END_VAR
    END_FUNCTION_BLOCK`,
    "FUNCTION_BLOCK Middle EXTENDS Base END_FUNCTION_BLOCK",
    "FUNCTION_BLOCK Base VAR PRIVATE CONSTANT seed: INT := 1; END_VAR VAR CONSTANT cap: INT := seed + 1; END_VAR END_FUNCTION_BLOCK",
  );
  expect(compileProject(project.pous).diagnostics).toEqual([]);
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  expect(readProject(saved.value!)).toEqual({ value: project, diagnostics: [] });
  const standard = readProject(stripSource(saved.value!));
  expect(standard.diagnostics).toEqual([]);
  expect(standard.value?.pous[1]).toContain("ARRAY[1..2] OF INT := [2(1)]");
  expect(standard.value?.pous[1]).not.toContain("seed :");
  expect(standard.value?.pous[1]).not.toContain("cap :");
});

it("avoids inherited names when synthesizing a bound-folding declaration", () => {
  const project = sampleProject("PROGRAM Main VAR d: Derived; END_VAR END_PROGRAM");
  project.pous.push(
    "FUNCTION_BLOCK Derived EXTENDS Base VAR a: ARRAY[1..__RANGE] OF INT; END_VAR END_FUNCTION_BLOCK",
    "FUNCTION_BLOCK Base VAR CONSTANT __RANGE: INT := 2; END_VAR END_FUNCTION_BLOCK",
  );
  expect(compileProject(project.pous).diagnostics).toEqual([]);
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  expect(readProject(saved.value!)).toEqual({ value: project, diagnostics: [] });
});

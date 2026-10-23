import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { XmlDocument, XsdValidator } from "libxml2-wasm";
import { describe, expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { readProject, SOURCE_NAMESPACE, writeProject } from "@benchtop-plc/project";
import type { Project } from "@benchtop-plc/project";

// The official TC6 v2.01 schema, mirrored at an immutable commit. See docs/project-format.md.
const schemaUrl =
  "https://raw.githubusercontent.com/mattsse/plcopen-xml-xcore/850175ace865e35d771785a62f3b3d6b2ed10bc1/schema/tc6_xml_v201.xsd";
const schemaHash = "ab1f43cdb29f134fff6037045d98e8d071e077bbb18f64a8d2e8b128bdc871d1";
function loadSchema(): string {
  const path =
    process.env.PLCOPEN_XSD_PATH ?? resolve("node_modules/.cache/plcopen/tc6_xml_v201.xsd");
  if (!existsSync(path)) {
    if (process.env.PLCOPEN_XSD_PATH) throw new Error(`PLCOPEN_XSD_PATH does not exist: ${path}`);
    mkdirSync(resolve("node_modules/.cache/plcopen"), { recursive: true });
    execFileSync("curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--max-time",
      "30",
      schemaUrl,
      "--output",
      path,
    ]);
  }
  const schema = readFileSync(path);
  expect(createHash("sha256").update(schema).digest("hex")).toBe(schemaHash);
  return schema.toString("utf8");
}
const project: Project = {
  fileHeader: {
    companyName: "benchtop-plc",
    productName: "benchtop-plc",
    productVersion: "0.0.0",
    creationDateTime: "2026-10-16T00:00:00Z",
  },
  contentHeader: { name: "Reference", language: "en" },
  dataTypes: [],
  pous: [readFileSync(new URL("./fixtures/reference.st", import.meta.url), "utf8")],
  configuration: "Config",
  resource: "Res",
  task: { name: "Cyclic", interval: "PT0.01S", priority: 1 },
  instance: { name: "mainInstance", typeName: "Main" },
  panel: {
    width: 800,
    height: 600,
    widgets: [
      { id: "start", kind: "pushbutton", address: "%IX0.0", x: 20, y: 40 },
      { id: "lamp", kind: "lamp", address: "%QX0.1", x: 100, y: 40 },
    ],
  },
};

describe("PLCopen TC6 v2.01 conformance", () => {
  it("round trips the reference ST program and a sample panel without data loss", () => {
    const written = writeProject(project);
    expect(written.diagnostics).toEqual([]);
    expect(written.value).not.toBeNull();
    expect(readProject(written.value!)).toEqual({ value: project, diagnostics: [] });
  });
  it.each(["blink", "running-light", "motor-starters"])(
    "resaves the bundled %s project without losing text",
    (name) => {
      const original = readProject(
        readFileSync(new URL(`../../examples/${name}/project.xml`, import.meta.url), "utf8"),
      );
      expect(original.diagnostics).toEqual([]);
      expect(original.value!.dataTypes).toEqual([]);
      if (name !== "motor-starters")
        expect(original.value!.pous).toEqual([
          readFileSync(
            new URL(`./${name === "blink" ? "reference" : name}/program.st`, import.meta.url),
            "utf8",
          ),
        ]);
      expect(readProject(writeProject(original.value!).value!)).toEqual(original);
    },
  );
  it("validates ordered POUs, function interfaces and tasks without a program instance", () => {
    const schema = XmlDocument.fromString(loadSchema());
    const validator = XsdValidator.fromDoc(schema);
    const functions = [
      "FUNCTION F : INT VAR_INPUT n : INT := 1; END_VAR VAR_OUTPUT q : INT; END_VAR VAR x : INT; END_VAR VAR_INPUT extra : INT; END_VAR F := n; END_FUNCTION",
      "FUNCTION Notify VAR_INPUT n : INT; END_VAR END_FUNCTION",
      "FUNCTION Constants : INT VAR CONSTANT N : INT := 10; END_VAR VAR x : INT := N; END_VAR Constants := x; END_FUNCTION",
      "FUNCTION Swap VAR_IN_OUT a,b : INT; END_VAR END_FUNCTION",
      "FUNCTION_BLOCK Increment VAR_IN_OUT n : INT; END_VAR n := n + 1; END_FUNCTION_BLOCK",
    ];
    try {
      for (const pous of [[...functions, ...project.pous], functions, []]) {
        const result = writeProject({ ...project, pous });
        expect(result.diagnostics).toEqual([]);
        expect(result.value).not.toBeNull();
        const document = XmlDocument.fromString(result.value!);
        try {
          expect(() => validator.validate(document)).not.toThrow();
          expect(readProject(result.value!).value!.pous).toEqual(pous);
        } finally {
          document.dispose();
        }
      }
    } finally {
      validator.dispose();
      schema.dispose();
    }
  }, 40000);
  it("validates named and inline data types and imports equivalent IR without source extensions", () => {
    const value: Project = {
      ...project,
      dataTypes: [
        "TYPE State : (Idle, Running, Done) := Running; END_TYPE",
        "TYPE Percent : INT (0..100) := 25; END_TYPE",
        "TYPE Count : UINT (0..1000); END_TYPE",
        "TYPE Speed : INT := 100; END_TYPE",
        "TYPE Ratio : Percent; END_TYPE",
        "TYPE Mode : UINT (Off := 0, Auto := 10, Manual := 20); END_TYPE",
      ],
      pous: [
        "PROGRAM Main VAR currentState : State; p : Percent; x : INT (0..100); u : UINT (0..100); END_VAR currentState := Next(currentState); END_PROGRAM",
        "FUNCTION Next : State VAR_INPUT s : State := Idle; END_VAR VAR p : Percent := 50; END_VAR Next := State#Done; END_FUNCTION",
      ],
    };
    const written = writeProject(value);
    expect(written.diagnostics).toEqual([]);
    const schema = XmlDocument.fromString(loadSchema());
    const validator = XsdValidator.fromDoc(schema);
    const document = XmlDocument.fromString(written.value!);
    try {
      expect(() => validator.validate(document)).not.toThrow();
      expect(readProject(written.value!).value).toEqual(value);
      const canonical = readProject(
        written.value!.replace(
          new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"),
          "",
        ),
      ).value!;
      const original = compileProject(value.pous, value.dataTypes);
      const imported = compileProject(canonical.pous, canonical.dataTypes);
      expect(original.diagnostics).toEqual([]);
      expect(imported.diagnostics).toEqual([]);
      const withoutSpans = (ir: unknown) =>
        JSON.parse(JSON.stringify(ir, (key, item: unknown) => (key === "span" ? undefined : item)));
      expect(withoutSpans(imported.ir)).toEqual(withoutSpans(original.ir));
    } finally {
      document.dispose();
      validator.dispose();
      schema.dispose();
    }
  });
  it("validates written and example XML against the official v2.01 XSD and detects an invalid document", () => {
    const schema = XmlDocument.fromString(loadSchema());
    const validator = XsdValidator.fromDoc(schema);
    const xml = writeProject(project).value!;
    const document = XmlDocument.fromString(xml);
    const example = XmlDocument.fromString(
      readFileSync(new URL("../../examples/blink/project.xml", import.meta.url), "utf8"),
    );
    const runningLight = XmlDocument.fromString(
      readFileSync(new URL("../../examples/running-light/project.xml", import.meta.url), "utf8"),
    );
    const motorStarters = XmlDocument.fromString(
      readFileSync(new URL("../../examples/motor-starters/project.xml", import.meta.url), "utf8"),
    );
    const invalid = XmlDocument.fromString(xml.replace('priority="1"', 'priority="65536"'));
    try {
      expect(() => validator.validate(document)).not.toThrow();
      expect(() => validator.validate(example)).not.toThrow();
      expect(() => validator.validate(runningLight)).not.toThrow();
      expect(() => validator.validate(motorStarters)).not.toThrow();
      expect(() => validator.validate(invalid)).toThrow();
    } finally {
      invalid.dispose();
      motorStarters.dispose();
      runningLight.dispose();
      example.dispose();
      document.dispose();
      validator.dispose();
      schema.dispose();
    }
  }, 40000);
});

it.each(["FUNCTION", "FUNCTION_BLOCK"])(
  "preserves %s in-out initializer errors across XML exchange without ignoring range checks",
  (kind) => {
    const pous = [
      "PROGRAM Main END_PROGRAM",
      `${kind} Callee VAR_IN_OUT n : INT := 5; END_VAR END_${kind}`,
    ];
    const written = writeProject({ ...project, pous });
    expect(written.diagnostics).toEqual([]);
    expect(written.value).not.toBeNull();
    const xml = written.value!;
    const canonical = xml.replace(
      new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"),
      "",
    );
    for (const source of [xml, canonical]) {
      const reopened = readProject(source);
      expect(reopened.diagnostics).toEqual([]);
      expect(reopened.value).not.toBeNull();
      const compiled = compileProject(reopened.value!.pous);
      expect(compiled.ir).toBeUndefined();
      expect(compiled.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "decl.in-out-initializer",
          pou: "Callee",
          args: { name: "n" },
        }),
      );
    }
    expect(readProject(xml).value!.pous).toEqual(pous);
    expect(
      writeProject({ ...project, pous: [pous[0]!, pous[1]!.replace(":= 5", ":= 40000")] }).value,
    ).toBeNull();
    expect(readProject(xml.replace('value="5"', 'value="40000"')).value).toBeNull();
    expect(
      writeProject({ ...project, pous: [pous[0]!, pous[1]!.replace(":= 5", ":= TRUE")] }).value,
    ).toBeNull();
  },
);

it("validates array dimensions and repeated initial values against TC6 v2.01", () => {
  const arrays: Project = {
    ...project,
    dataTypes: [
      "TYPE Table : ARRAY[1..5] OF INT := [1, 2, 3(0)]; END_TYPE",
      "TYPE Nested : ARRAY[1..2] OF ARRAY[1..2] OF REAL := [2([1.5, 2.5])]; END_TYPE",
    ],
    pous: [
      "PROGRAM Main VAR a : Table; b : ARRAY[0..1,0..2] OF INT := [2(1, 2), 2(0)]; n : Nested; END_VAR END_PROGRAM",
    ],
  };
  const written = writeProject(arrays);
  expect(written.diagnostics).toEqual([]);
  const schema = XmlDocument.fromString(loadSchema());
  const validator = XsdValidator.fromDoc(schema);
  const document = XmlDocument.fromString(written.value!);
  try {
    expect(() => validator.validate(document)).not.toThrow();
    expect(readProject(written.value!).value).toEqual(arrays);
  } finally {
    document.dispose();
    validator.dispose();
    schema.dispose();
  }
});

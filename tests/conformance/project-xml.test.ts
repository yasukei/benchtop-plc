import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { XmlDocument, XsdValidator } from "libxml2-wasm";
import { describe, expect, it } from "vitest";
import { readProject, writeProject } from "@benchtop-plc/project";
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
  program: readFileSync(new URL("./fixtures/reference.st", import.meta.url), "utf8"),
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
    const invalid = XmlDocument.fromString(xml.replace('priority="1"', 'priority="65536"'));
    try {
      expect(() => validator.validate(document)).not.toThrow();
      expect(() => validator.validate(example)).not.toThrow();
      expect(() => validator.validate(runningLight)).not.toThrow();
      expect(() => validator.validate(invalid)).toThrow();
    } finally {
      invalid.dispose();
      runningLight.dispose();
      example.dispose();
      document.dispose();
      validator.dispose();
      schema.dispose();
    }
  }, 40000);
});

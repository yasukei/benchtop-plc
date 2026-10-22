import sampleXml from "../../../../examples/blink/project.xml?raw";
import { readProject, writeProject } from "@benchtop-plc/project";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { addPart, buttonColors, movePart } from "./layout.js";
import { openPanelProject, savePanelProject } from "./project.js";
import { demoSource } from "../demo.js";

describe("panel project persistence", () => {
  it("stamps new projects with the app package version", () => {
    const project = readProject(savePanelProject([demoSource], [], 10, null)!).value!;
    expect(project.fileHeader).toMatchObject({
      companyName: "benchtop-plc",
      productName: "benchtop-plc",
      productVersion: packageJson.version,
    });
  });
  it("keeps the checked-in example header at the current release version", () => {
    expect(readProject(sampleXml).value!.fileHeader.productVersion).toBe(packageJson.version);
  });
  it.each(["bundled example", "older project", "foreign project"])(
    "stamps the app writer identity when resaving a %s and preserves unrelated metadata",
    (kind) => {
      const project = readProject(sampleXml).value!;
      if (kind === "older project") project.fileHeader.productVersion = "0.0.0";
      project.fileHeader.companyName = "Example company";
      if (kind === "foreign project") {
        project.fileHeader.companyName = "OtherCompany";
        project.fileHeader.productName = "OtherTool";
        project.fileHeader.productVersion = "9.8.7";
      }
      project.fileHeader.companyURL = "https://example.com";
      project.fileHeader.productRelease = "Original release";
      project.fileHeader.contentDescription = "Original description";
      project.contentHeader.author = "Example author";
      project.contentHeader.version = "Project revision 3";
      const original = structuredClone(project);
      const opened = openPanelProject(writeProject(project).value!)!;
      const saved = readProject(
        savePanelProject(opened.project.pous, opened.layout, 10, opened.project)!,
      ).value!;
      expect(saved).toEqual({
        ...original,
        fileHeader: {
          ...original.fileHeader,
          companyName: "benchtop-plc",
          productName: "benchtop-plc",
          productVersion: packageJson.version,
        },
      });
      expect(opened.project).toEqual(original);
    },
  );
  it.each([
    sampleXml.replace(
      /<panel:panel version="1">[\s\S]*?<\/panel:panel>/,
      '<panel:panel version="1">null</panel:panel>',
    ),
    sampleXml.replace(/<addData>[\s\S]*?<\/addData>/, ""),
  ])("opens projects with null or absent panel data as empty layouts", (xml) => {
    expect(readProject(xml).value?.panel).toBeNull();
    const opened = openPanelProject(xml);
    expect(opened?.layout).toEqual([]);
    expect(opened?.project.pous[0]).toContain("PROGRAM Main");
    expect(opened?.project.pous[0]).toContain("Running := (StartPB OR Running) AND NOT StopPB;");
  });
  it.each([{}, false, [{ kind: "led" }]])("rejects malformed non-null panel data: %j", (panel) => {
    const project = readProject(sampleXml).value!;
    const xml = writeProject({ ...project, panel }).value!;
    expect(openPanelProject(xml)).toBeNull();
  });
  it("round trips layout, fractional positions, source and project metadata through PLCopen XML", () => {
    const layout = movePart(
      addPart(addPart([], "led", "Lamp"), "estop", "Emergency"),
      "1",
      0.2,
      0.8,
    );
    const xml = savePanelProject([demoSource], layout, 20, null)!;
    expect(xml).toContain("http://www.plcopen.org/xml/tc6_0201");
    const opened = openPanelProject(xml)!;
    expect(opened.layout).toEqual(layout);
    expect(opened.project.pous[0]!).toBe(demoSource);
    expect(opened.project.task.interval).toBe("PT0.02S");
    opened.project.contentHeader.author = "Example";
    const reopened = openPanelProject(savePanelProject([demoSource], layout, 50, opened.project)!)!;
    expect(reopened.project.contentHeader.author).toBe("Example");
    expect(reopened.project.task.interval).toBe("PT0.05S");
  });
  it("rejects invalid source and malformed XML", () => {
    expect(savePanelProject(["invalid"], [], 10, null)).toBeNull();
    expect(openPanelProject("invalid")).toBeNull();
  });
  it("round trips both input palettes and migrates legacy amber through XML", () => {
    const layout = (["pushbutton", "selector"] as const).flatMap((kind) =>
      ([...buttonColors, "amber"] as const).map((color, index) => ({
        ...addPart([], kind, "Input")[0]!,
        id: `${kind}-${index}`,
        color,
      })),
    );
    const opened = openPanelProject(savePanelProject([demoSource], layout, 10, null)!)!;
    expect(opened.layout).toEqual(
      layout.map((part) => ({
        ...part,
        color: part.color === "amber" ? "yellow" : part.color,
      })),
    );
  });
});

it("saves semantic errors and keeps other POU texts while editing the program", () => {
  const original = readProject(sampleXml).value!;
  const fn = "FUNCTION F : INT F := 1; END_FUNCTION";
  original.pous = [fn, original.pous[0]!];
  const source = "PROGRAM Changed VAR x : INT; END_VAR x := Missing(1); END_PROGRAM";
  const saved = readProject(savePanelProject([fn, source], [], 10, original)!);
  expect(saved.diagnostics).toEqual([]);
  expect(saved.value!.pous).toEqual([fn, source]);
  expect(saved.value!.instance!.typeName).toBe("Changed");
  expect(original.pous[1]).toContain("PROGRAM Main");
});

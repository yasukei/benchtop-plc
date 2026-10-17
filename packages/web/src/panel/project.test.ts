import sampleXml from "../../../../examples/blink/project.xml?raw";
import { readProject, writeProject } from "@benchtop-plc/project";
import { describe, expect, it } from "vitest";
import { addPart, movePart } from "./layout.js";
import { openPanelProject, savePanelProject } from "./project.js";
import { demoSource } from "../demo.js";

describe("panel project persistence", () => {
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
    expect(opened?.project.program).toContain("PROGRAM Main");
    expect(opened?.project.program).toContain("Running := (StartPB OR Running) AND NOT StopPB;");
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
    const xml = savePanelProject(demoSource, layout, 20, null)!;
    expect(xml).toContain("http://www.plcopen.org/xml/tc6_0201");
    const opened = openPanelProject(xml)!;
    expect(opened.layout).toEqual(layout);
    expect(opened.project.program).toBe(demoSource);
    expect(opened.project.task.interval).toBe("PT0.02S");
    opened.project.contentHeader.author = "Example";
    const reopened = openPanelProject(savePanelProject(demoSource, layout, 50, opened.project)!)!;
    expect(reopened.project.contentHeader.author).toBe("Example");
    expect(reopened.project.task.interval).toBe("PT0.05S");
  });
  it("rejects invalid source and malformed XML", () => {
    expect(savePanelProject("invalid", [], 10, null)).toBeNull();
    expect(openPanelProject("invalid")).toBeNull();
  });
});

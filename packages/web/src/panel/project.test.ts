import { describe, expect, it } from "vitest";
import { addPart, movePart } from "./layout.js";
import { openPanelProject, savePanelProject } from "./project.js";
import { demoSource } from "../demo.js";

describe("panel project persistence", () => {
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

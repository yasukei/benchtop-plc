import sampleXml from "../../../../examples/blink/project.xml?raw";
import { readProject, writeProject } from "@benchtop-plc/project";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { addPart, buttonColors, movePart } from "./layout.js";
import { openPanelProject, savePanelProject } from "./project.js";
import { demoSource } from "../demo.js";

describe("panel project persistence", () => {
  // The codec's vendor-data and stale-source warning fixtures, applied to the example.
  it.each([
    [
      sampleXml.replace(
        "</addData></project>",
        '<data name="https://vendor.example/1" handleUnknown="preserve"><v:payload xmlns:v="https://vendor.example/1"/></data></addData></project>',
      ),
      "project.dropped-data",
    ],
    [sampleXml.replace('value="T#500ms"', 'value="T#250ms"'), "project.stale-source"],
  ])("carries successful read warnings through the adapter (fixture %#)", (xml, code) => {
    const decoded = readProject(xml);
    expect(decoded.value).not.toBeNull();
    expect(decoded.diagnostics).toContainEqual(
      expect.objectContaining({ code, severity: "warning" }),
    );
    const opened = openPanelProject(xml)!;
    expect(opened.project).toEqual(decoded.value);
    expect(opened.diagnostics).toEqual(decoded.diagnostics);
  });

  it("collapses repeated vendor and stale-source warnings while keeping distinct vendors", () => {
    const source = "PROGRAM Main VAR x : INT := 1; END_VAR END_PROGRAM";
    const project = {
      ...readProject(sampleXml).value!,
      pous: [source, source.replace("Main", "Other")],
    };
    const vendor =
      '<data name="https://vendor.example/1" handleUnknown="preserve"><v:payload xmlns:v="https://vendor.example/1"/></data>';
    const xml = writeProject(project)
      .value!.replaceAll('value="1"', 'value="2"')
      .replaceAll("</addData>", `${vendor}</addData>`)
      .replace(
        "</addData></project>",
        `${vendor.replaceAll("example/1", "example/2")}</addData></project>`,
      );
    const decoded = readProject(xml);
    expect(decoded.value).not.toBeNull();
    expect(decoded.diagnostics.filter((item) => item.code === "project.stale-source")).toHaveLength(
      2,
    );
    expect(
      decoded.diagnostics.filter(
        (item) =>
          item.code === "project.dropped-data" && item.args.name === "https://vendor.example/1",
      ).length,
    ).toBeGreaterThan(1);
    const opened = openPanelProject(xml)!;
    expect(opened.project).toEqual(decoded.value);
    expect(opened.diagnostics).toHaveLength(3);
    expect(opened.diagnostics).toEqual(
      expect.arrayContaining([
        {
          code: "project.dropped-data",
          severity: "warning",
          args: { name: "https://vendor.example/1" },
        },
        {
          code: "project.dropped-data",
          severity: "warning",
          args: { name: "https://vendor.example/2" },
        },
        { code: "project.stale-source", severity: "warning", args: {} },
      ]),
    );
  });

  it("stamps new projects with the app package version", () => {
    const project = readProject(savePanelProject([demoSource], [], 10, null, [])!).value!;
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
        savePanelProject(
          opened.project.pous,
          opened.layout,
          10,
          opened.project,
          opened.project.dataTypes,
        )!,
      ).value!;
      const expectedHeader = { ...original.fileHeader };
      delete expectedHeader.companyURL;
      delete expectedHeader.productRelease;
      expect(saved).toEqual({
        ...original,
        fileHeader: {
          ...expectedHeader,
          companyName: "benchtop-plc",
          productName: "benchtop-plc",
          productVersion: packageJson.version,
        },
      });
      expect(saved.fileHeader).not.toHaveProperty("companyURL");
      expect(saved.fileHeader).not.toHaveProperty("productRelease");
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
    const xml = savePanelProject([demoSource], layout, 20, null, [])!;
    expect(xml).toContain("http://www.plcopen.org/xml/tc6_0201");
    const opened = openPanelProject(xml)!;
    expect(opened.layout).toEqual(layout);
    expect(opened.project.pous[0]!).toBe(demoSource);
    expect(opened.project.task.interval).toBe("PT0.02S");
    opened.project.contentHeader.author = "Example";
    const reopened = openPanelProject(
      savePanelProject([demoSource], layout, 50, opened.project, opened.project.dataTypes)!,
    )!;
    expect(reopened.project.contentHeader.author).toBe("Example");
    expect(reopened.project.task.interval).toBe("PT0.05S");
  });
  it("rejects invalid source and malformed XML", () => {
    expect(savePanelProject(["invalid"], [], 10, null, [])).toBeNull();
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
    const opened = openPanelProject(savePanelProject([demoSource], layout, 10, null, [])!)!;
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
  const saved = readProject(savePanelProject([fn, source], [], 10, original, original.dataTypes)!);
  expect(saved.diagnostics).toEqual([]);
  expect(saved.value!.pous).toEqual([fn, source]);
  expect(saved.value!.instance!.typeName).toBe("Changed");
  expect(original.pous[1]).toContain("PROGRAM Main");
});

it.each([{ dataTypes: [] }, { dataTypes: ["TYPE Speed : INT; END_TYPE"] }])(
  "saves the explicit edited type list instead of stale project metadata: %j",
  ({ dataTypes }) => {
    const project = readProject(sampleXml).value!;
    project.dataTypes = ["TYPE OldType : (Idle, Running); END_TYPE"];
    const saved = readProject(savePanelProject(project.pous, [], 10, project, dataTypes)!);
    expect(saved.diagnostics).toEqual([]);
    expect(saved.value!.dataTypes).toEqual(dataTypes);
    expect(project.dataTypes).toEqual(["TYPE OldType : (Idle, Running); END_TYPE"]);
  },
);

it("saves the 0.5.0 panel unchanged as version 1", () => {
  const original = readProject(sampleXml).value!;
  const opened = openPanelProject(sampleXml)!;
  expect(opened.layout[0]).toHaveProperty("address", "%IX0.0");
  const xml = savePanelProject(original.pous, opened.layout, 10, original, original.dataTypes)!;
  expect(xml).toContain('<panel:panel version="1">');
  expect(readProject(xml).value?.panel).toEqual(original.panel);
});
it("saves a lamp beyond byte zero as version 2 and opens it with its address", () => {
  const layout = [{ ...addPart([], "led", "Lamp")[0]!, address: "%QX1.0" }];
  const xml = savePanelProject(["PROGRAM Main END_PROGRAM"], layout, 10, null, [])!;
  expect(xml).toContain('<panel:panel version="2">');
  expect(xml).not.toContain("&quot;bit&quot;");
  expect(openPanelProject(xml)?.layout).toEqual(layout);
});

it("round trips numeric parts as version 2 and returns to version 1 when removed", () => {
  const input = { ...addPart([], "numericInput", "Setpoint")[0]!, min: -10, max: 100 };
  const display = {
    ...addPart([input], "numericDisplay", "")[1]!,
    address: "%QD1",
    dataType: "REAL" as const,
  };
  const layout = [input, display];
  const xml = savePanelProject([demoSource], layout, 10, null, [])!;
  expect(xml).toContain('<panel:panel version="2">');
  expect(openPanelProject(xml)?.layout).toEqual(layout);
  expect(savePanelProject([demoSource], addPart([], "led", "Lamp"), 10, null, [])).toContain(
    '<panel:panel version="1">',
  );
});

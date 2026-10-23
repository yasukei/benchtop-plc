import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject, writeProject } from "@benchtop-plc/project";
import packageJson from "../package.json" with { type: "json" };

const sampleXml = readFileSync(
  new URL("../../../examples/blink/project.xml", import.meta.url),
  "utf8",
);

for (const kind of ["bundled example", "older project", "foreign project"] as const) {
  test(`saves the ${kind} with the app writer identity and preserves other metadata`, async ({
    page,
  }) => {
    await page.goto("/");
    const original = readProject(sampleXml).value!;
    if (kind !== "bundled example") {
      original.fileHeader.productVersion = "0.0.0";
      original.contentHeader.name = "Imported project";
      original.contentHeader.author = "Original author";
    }
    if (kind === "foreign project") {
      Object.assign(original.fileHeader, {
        companyName: "OtherCompany",
        productName: "OtherTool",
        productVersion: "9.8.7",
        creationDateTime: "2025-01-02T03:04:05Z",
        companyURL: "https://example.com",
        productRelease: "Original release",
        contentDescription: "Original description",
      });
      original.contentHeader.version = "Project revision 3";
      original.contentHeader.organization = "Original organization";
      original.contentHeader.modificationDateTime = "2025-02-03T04:05:06Z";
    }
    if (kind !== "bundled example") {
      await page.getByLabel("Open project", { exact: true }).setInputFiles({
        name: "imported.xml",
        mimeType: "application/xml",
        buffer: Buffer.from(writeProject(original).value!),
      });
    }
    await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save project", exact: true }).click();
    const download = await downloadPromise;
    const saved = readProject(readFileSync((await download.path())!, "utf8")).value!;
    const expectedHeader = { ...original.fileHeader };
    delete expectedHeader.companyURL;
    delete expectedHeader.productRelease;
    expect(saved.fileHeader).toEqual({
      ...expectedHeader,
      companyName: "benchtop-plc",
      productName: "benchtop-plc",
      productVersion: packageJson.version,
    });
    expect(saved.fileHeader).not.toHaveProperty("companyURL");
    expect(saved.fileHeader).not.toHaveProperty("productRelease");
    expect(saved.contentHeader).toEqual(original.contentHeader);
  });
}

for (const available of [true, false]) {
  test(`opens and saves function projects when the called function is ${available ? "available" : "missing"}`, async ({
    page,
  }) => {
    const main = "PROGRAM Main\nVAR x : INT; END_VAR\nx := F(1);\nEND_PROGRAM";
    const fn = "FUNCTION F : INT\nVAR_INPUT n : INT; END_VAR\nF := n + 1;\nEND_FUNCTION";
    const pous = available ? [fn, main] : [main];
    const project = { ...readProject(sampleXml).value!, pous, panel: [] };
    const xml = writeProject(project).value!;
    await page.goto("/");
    await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
    await page.getByLabel("Open project", { exact: true }).setInputFiles({
      name: "functions.xml",
      mimeType: "application/xml",
      buffer: Buffer.from(xml),
    });
    await expect(page.getByRole("textbox", { name: "Structured Text", exact: true })).toContainText(
      "x := F(1);",
    );
    const diagnostics = page.getByRole("region", { name: "Diagnostics", exact: true });
    if (available) {
      await expect(diagnostics).toContainText("No diagnostics");
      await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Single scan", exact: true }).click();
      const row = page
        .getByRole("row")
        .filter({ has: page.getByRole("rowheader", { name: "x", exact: true }) });
      await expect(row.locator("td").nth(2)).toHaveText("2");
    } else {
      await expect(diagnostics).toContainText("Unknown function: F.");
      await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
    }
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save project", exact: true }).click();
    const download = await downloadPromise;
    const saved = readProject(readFileSync((await download.path())!, "utf8"));
    expect(saved.diagnostics).toEqual([]);
    expect(saved.value!.pous).toEqual(pous);
    if (available) {
      // The main text is unchanged, but its compiled dependency has disappeared.
      const missing = writeProject({ ...project, pous: [main] }).value!;
      await page.getByLabel("Open project", { exact: true }).setInputFiles({
        name: "missing-function.xml",
        mimeType: "application/xml",
        buffer: Buffer.from(missing),
      });
      await expect(diagnostics).toContainText("Unknown function: F.");
      await expect(page.getByRole("button", { name: "Single scan", exact: true })).toBeDisabled();
      await page.getByRole("button", { name: "RUN", exact: true }).click();
      await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
      await expect(page.getByText("Unapplied changes", { exact: true })).toBeVisible();
    }
  });
}

test("opens, runs, autosaves and resaves ordered data types with their exact texts", async ({
  page,
}) => {
  const dataTypes = [
    "// Keep this text\r\ntype State : (Idle, Running, Done) := Running; end_type;\r\n",
    "TYPE Percent : INT (0..100) := 25; END_TYPE",
  ];
  const pous = [
    "PROGRAM Main VAR currentState : State; p : Percent; inlineValue : INT (0..100) := 10; END_VAR currentState := Next(currentState); p := p + 1; END_PROGRAM",
    "FUNCTION Next : State VAR_INPUT s : State; END_VAR Next := State#Done; END_FUNCTION",
  ];
  const project = { ...readProject(sampleXml).value!, dataTypes, pous, panel: [] };
  const written = writeProject(project);
  expect(written.diagnostics).toEqual([]);
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "types.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(written.value!),
  });
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    "No diagnostics",
  );
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const row = (name: string) =>
    page.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });
  await expect(row("currentState").locator("td").nth(2)).toHaveText("Running");
  await expect(row("p").locator("td").nth(2)).toHaveText("25");
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(row("currentState").locator("td").nth(2)).toHaveText("Done");
  await expect(row("p").locator("td").nth(2)).toHaveText("26");
  // Immediate reload flushes the browser autosave and restores the type context.
  await page.reload();
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    "No diagnostics",
  );
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(row("currentState").locator("td").nth(2)).toHaveText("Done");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const path = (await (await downloadPromise).path())!;
  const saved = readProject(readFileSync(path, "utf8"));
  expect(saved.diagnostics).toEqual([]);
  expect(saved.value!.dataTypes).toEqual(dataTypes);
  expect(saved.value!.pous).toEqual(pous);
  await page.getByLabel("Open project", { exact: true }).setInputFiles(path);
  await expect(row("currentState").locator("td").nth(2)).toHaveText("Running");
});

test("preserves an unresolved enum type default without routing its diagnostic into a POU", async ({
  page,
}) => {
  const dataTypes = ["TYPE State : (Idle, Running) := State#Missing; END_TYPE"];
  const project = {
    ...readProject(sampleXml).value!,
    dataTypes,
    pous: ["PROGRAM Main VAR s : State; END_VAR END_PROGRAM"],
    panel: [],
  };
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "unresolved.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(writeProject(project).value!),
  });
  const diagnostics = page.getByRole("region", { name: "Diagnostics", exact: true });
  await expect(diagnostics).toContainText("Missing");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await expect(editor).toContainText("PROGRAM Main");
  await expect(page.locator(".cm-lintRange-error")).toHaveCount(0);
  await diagnostics.getByRole("button").click();
  await expect(editor).toHaveText(dataTypes[0]!);
  await expect(page.locator(".cm-lintRange-error")).not.toHaveCount(0);
  const list = page.getByRole("region", { name: "POUs", exact: true });
  await expect(list.getByRole("button", { name: /^Main/ })).toContainText("Diagnostics: 0");
  await expect(page.getByRole("button", { name: "Single scan", exact: true })).toBeDisabled();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const saved = readProject(readFileSync((await (await downloadPromise).path())!, "utf8"));
  expect(saved.value!.dataTypes).toEqual(dataTypes);
});

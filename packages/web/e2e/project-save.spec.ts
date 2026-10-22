import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject, writeProject } from "@benchtop-plc/project";
import packageJson from "../package.json" with { type: "json" };

const sampleXml = readFileSync(
  new URL("../../../examples/blink/project.xml", import.meta.url),
  "utf8",
);

for (const kind of ["bundled example", "older project"] as const) {
  test(`saves the ${kind} with the app version and preserves other headers`, async ({ page }) => {
    await page.goto("/");
    const originalXml =
      kind === "older project"
        ? sampleXml
            .replace(/productVersion="[^"]*"/, 'productVersion="0.0.0"')
            .replace('name="Blink"', 'name="Legacy project" author="Original author"')
        : sampleXml;
    if (kind === "older project") {
      await page.getByLabel("Open project", { exact: true }).setInputFiles({
        name: "legacy.xml",
        mimeType: "application/xml",
        buffer: Buffer.from(originalXml),
      });
    }
    await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save project", exact: true }).click();
    const download = await downloadPromise;
    const saved = readProject(readFileSync((await download.path())!, "utf8")).value!;
    const original = readProject(originalXml).value!;
    expect(saved.fileHeader).toEqual({
      ...original.fileHeader,
      productVersion: packageJson.version,
    });
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

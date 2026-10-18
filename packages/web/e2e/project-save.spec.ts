import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject } from "@benchtop-plc/project";
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

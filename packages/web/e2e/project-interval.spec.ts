import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { en, ja } from "../src/catalog.js";

const sampleXml = readFileSync(
  new URL("../../../examples/blink/project.xml", import.meta.url),
  "utf8",
);

test("opens equivalent task intervals and explains unsupported cycles in both languages", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const cycle = page.getByRole("combobox", { name: "Cycle (ms)", exact: true });
  await cycle.selectOption("100");
  const upload = async (interval: string) => {
    await page.getByLabel("Open project", { exact: true }).setInputFiles({
      name: "interval.xml",
      mimeType: "application/xml",
      buffer: Buffer.from(sampleXml.replace('interval="PT0.01S"', `interval="${interval}"`)),
    });
  };
  await upload("PT0H0M0.01S");
  await expect(cycle).toHaveValue("10");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(page.getByLabel("Scans", { exact: true })).toHaveText("1");

  await upload("PT1S");
  await expect(page.getByRole("alert")).toHaveText(en.unsupportedProjectCycle);
  await expect(cycle).toHaveValue("10");
  await expect(page.getByLabel("Scans", { exact: true })).toHaveText("1");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(page.getByRole("alert")).toHaveText(ja.unsupportedProjectCycle);
  await page.getByRole("combobox", { name: "言語", exact: true }).selectOption("en");

  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "invalid.xml",
    mimeType: "application/xml",
    buffer: Buffer.from("invalid XML"),
  });
  await expect(page.getByRole("alert")).toHaveText(en.projectError);
  await upload("PT0H0M0.01S");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
});

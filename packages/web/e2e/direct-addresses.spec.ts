import { expect, test } from "@playwright/test";
import { savePanelProject } from "../src/panel/project.js";
import type { PanelLayout } from "../src/panel/layout.js";

test("operates and resaves panel bits beyond byte zero", async ({ page }) => {
  const layout: PanelLayout = [
    { id: "1", kind: "selector", label: "Start", address: "%IX63.7", color: "green", x: 0, y: 0 },
    { id: "2", kind: "led", label: "Lamp", address: "%QX1.0", color: "green", x: 0.5, y: 0 },
    { id: "3", kind: "estop", label: "Emergency", address: null, color: "red", x: 1, y: 0 },
  ];
  const source = `PROGRAM Main VAR start AT %IX63.7 : BOOL; lamp AT %QX1.0 : BOOL;
    analog AT %IW0 : INT; END_VAR lamp := start; END_PROGRAM`;
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "addresses.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(
      savePanelProject(
        [source],
        layout,
        10,
        null,
        [],
        `CONFIGURATION Plant RESOURCE Station ON Cpu
      TASK T (INTERVAL := T#10ms, PRIORITY := 1); TASK Edge (SINGLE := %IX3.5, PRIORITY := 0);
      PROGRAM A WITH T : Main; END_RESOURCE END_CONFIGURATION`,
      )!,
    ),
  });
  const image = page.getByRole("region", { name: "I/O image", exact: true });
  await expect(image.getByLabel("%IW0", { exact: true })).toContainText("0");
  await expect(image.getByLabel("%IX3.5", { exact: true })).toContainText("OFF");
  await expect(image.getByLabel("%IX0.1", { exact: true })).toHaveCount(0);
  await page.getByRole("switch", { name: "Start", exact: true }).click();
  await expect(image.getByLabel("%IX63.7", { exact: true })).toContainText("ON");
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByRole("status", { name: "Lamp", exact: true })).toHaveAttribute(
    "data-on",
    "true",
  );
  await expect(image.getByLabel("%QX1.0", { exact: true })).toContainText("ON");
  await page.getByRole("button", { name: "Emergency", exact: true }).click();
  await expect(image.getByLabel("%QX1.0", { exact: true })).toContainText("OFF");
  await page.getByRole("button", { name: "Emergency", exact: true }).click();
  await page.getByRole("button", { name: "Edit panel", exact: true }).click();
  await page.getByRole("button", { name: "Lamp", exact: true }).click();
  await page.getByRole("combobox", { name: "Address", exact: true }).selectOption("%QX63.7");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const file = await download;
  const { readFileSync } = await import("node:fs");
  const xml = readFileSync((await file.path())!, "utf8");
  expect(xml).toContain('<panel:panel version="2">');
  expect(xml).toContain("%QX63.7");
});

test("shows invalid REAL patterns without a host error and faults on program read", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const source = `PROGRAM Main VAR bits AT %MD0 : DWORD; sample AT %MD0 : REAL;
    readNow : BOOL; copy : REAL; END_VAR
    bits := DWORD#16#7FC00000; IF readNow THEN copy := sample; END_IF; END_PROGRAM`;
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "invalid-real.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(savePanelProject([source], [], 10, null, [])!),
  });
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  const monitor = page.locator("section[aria-labelledby=monitor-title]");
  const sample = monitor
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "sample", exact: true }) });
  await expect(sample).toContainText("Invalid (16#7FC00000)");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(sample).toContainText("無効 (16#7FC00000)");
  await page.getByRole("combobox", { name: "言語", exact: true }).selectOption("en");
  const trigger = monitor
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "readNow", exact: true }) });
  await trigger.getByRole("button", { name: "Force TRUE", exact: true }).click();
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    "Non-finite result",
  );
  await expect(sample).toContainText("16#7FC00000");
  expect(errors).toEqual([]);
});

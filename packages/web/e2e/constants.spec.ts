import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject } from "@benchtop-plc/project";

test("executes constants, omits them from the monitor, and saves and reopens dependent initializers", async ({
  page,
}) => {
  const source = `PROGRAM Constants
VAR CONSTANT MAX_COUNT : INT := 10; N : INT := 30000; END_VAR
VAR A : INT := MAX_COUNT; Wrapped : INT := N + N; Selected : BOOL; END_VAR
CASE A OF MAX_COUNT: Selected := TRUE; END_CASE;
END_PROGRAM`;
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(source);
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    "No diagnostics",
  );
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const download = await downloadPromise;
  const xml = readFileSync((await download.path())!, "utf8");
  expect(xml).toContain('<localVars constant="true">');
  expect(readProject(xml).value!.pous).toEqual([source]);
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "constants.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await expect(editor).toContainText("VAR CONSTANT MAX_COUNT");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  await expect(monitor.getByRole("row")).toHaveCount(4);
  for (const [name, value] of [
    ["A", "10"],
    ["Wrapped", "-5536"],
    ["Selected", "TRUE"],
  ]) {
    const row = monitor
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name, exact: true }) });
    await expect(row.locator("td").nth(2)).toHaveText(value!);
  }
  await expect(monitor.getByRole("rowheader", { name: "MAX_COUNT", exact: true })).toHaveCount(0);
  await expect(monitor.getByRole("rowheader", { name: "N", exact: true })).toHaveCount(0);
});

test("shows a localized diagnostic when assigning a constant", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(
    "PROGRAM Main VAR CONSTANT N : INT := 10; END_VAR N := 5; END_PROGRAM",
  );
  const diagnostics = page.getByRole("region", { name: "Diagnostics", exact: true });
  await expect(diagnostics).toContainText("Constant N cannot be written.");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(page.getByRole("region", { name: "診断", exact: true })).toContainText(
    "定数 N には書き込めません。",
  );
});

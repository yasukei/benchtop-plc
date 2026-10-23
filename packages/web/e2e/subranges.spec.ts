import { expect, test } from "@playwright/test";

test("shows an inline subrange and rejects monitor writes and forces outside its limits", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(
    "PROGRAM Ranges VAR offsetValue : INT (-10..10); END_VAR END_PROGRAM",
  );
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  await page
    .getByRole("region", { name: "Runtime controls", exact: true })
    .getByRole("button", { name: "STOP", exact: true })
    .click();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const row = monitor
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: /^offsetValue/ }) });
  await expect(row.locator("td").nth(1)).toHaveText("INT (-10..10)");
  await expect(row.locator("td").nth(2)).toHaveText("-10");
  await row.getByLabel("Value to write").fill("10");
  await row.getByRole("button", { name: "Write", exact: true }).click();
  await expect(row.locator("td").nth(2)).toHaveText("10");
  for (const action of ["Write", "Force"]) {
    await row.getByLabel("Value to write").fill("11");
    await row.getByRole("button", { name: action, exact: true }).click();
    await expect(row.getByRole("alert")).toContainText("valid value");
    await expect(row.locator("td").nth(2)).toHaveText("10");
    await expect(row).toHaveAttribute("data-forced", "false");
  }
});

test("shows localized subrange faults for dynamic assignments", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(
    "PROGRAM Ranges VAR p : INT (0..100); source : INT := 120; END_VAR p := source; END_PROGRAM",
  );
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("FAULT");
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    "Value 120 is outside subrange 0..100.",
  );
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(page.getByRole("region", { name: "診断", exact: true })).toContainText(
    "値 120 は部分範囲 0..100 の範囲外です。",
  );
});

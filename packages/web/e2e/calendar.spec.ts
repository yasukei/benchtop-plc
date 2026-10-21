import { expect, test } from "@playwright/test";

test("writes and forces calendar literals in the monitor through the Worker", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(`PROGRAM Calendar
VAR stamp: DT; mirror: DT; day: DATE := D#2024-02-29; longStamp: LDT;
END_VAR
mirror := stamp;
END_PROGRAM`);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const row = (name: string) =>
    monitor
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name: new RegExp(`^${name}(?: Forced)?$`) }) });
  await expect(row("day").locator("td").nth(2)).toHaveText("D#2024-02-29");
  await expect(row("stamp").locator("td").nth(2)).toHaveText("DT#1970-01-01-00:00:00");
  await row("stamp").getByLabel("Value to write").fill("DT#2_026-10-20-12:30:15");
  await row("stamp").getByRole("button", { name: "Write", exact: true }).click();
  await expect(row("stamp").locator("td").nth(2)).toHaveText("DT#2026-10-20-12:30:15");
  await expect(row("mirror").locator("td").nth(2)).toHaveText("DT#2026-10-20-12:30:15");
  await row("stamp").getByLabel("Value to write").fill("DT#2026-02-30-00:00:00");
  await row("stamp").getByRole("button", { name: "Write", exact: true }).click();
  await expect(row("stamp").getByRole("alert")).toContainText("valid value");
  await expect(row("stamp").locator("td").nth(2)).toHaveText("DT#2026-10-20-12:30:15");
  await row("longStamp").getByLabel("Value to write").fill("LDT#1_677-9-21-0:12:43.145_224_192");
  await row("longStamp").getByRole("button", { name: "Force", exact: true }).click();
  await expect(row("longStamp")).toHaveAttribute("data-forced", "true");
  await expect(row("longStamp").locator("td").nth(2)).toHaveText(
    "LDT#1677-09-21-00:12:43.145224192",
  );
});

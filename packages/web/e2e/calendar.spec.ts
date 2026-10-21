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

test("combines and splits calendar values with output assignments in the Worker", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(`PROGRAM CalendarFunctions
VAR stamp: LDT; y: LINT; m: INT; d: INT; ok: BOOL; weekday: INT; rounded: TIME; wrapped: TOD; END_VAR
stamp := CONCAT_DATE_LTOD(D#2024-02-29, LTOD#12:30:00.000000001);
ok := SPLIT_LDT(IN := stamp, YEAR => y, MONTH => m, DAY => d);
weekday := DAY_OF_WEEK(D#2026-10-20);
rounded := MUL_TIME(T#3ms, 0.5);
wrapped := ADD_TOD_TIME(TOD#23:00:00, T#2h);
END_PROGRAM`);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  for (const [name, value] of [
    ["stamp", "LDT#2024-02-29-12:30:00.000000001"],
    ["y", "2024"],
    ["m", "2"],
    ["d", "29"],
    ["ok", "TRUE"],
    ["weekday", "2"],
    ["rounded", "T#2ms"],
    ["wrapped", "TOD#01:00:00"],
  ]) {
    const row = monitor
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name, exact: true }) });
    await expect(row.locator("td").nth(2)).toHaveText(value!);
  }
});

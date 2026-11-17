import { expect, test } from "@playwright/test";

test("writes and forces sub-millisecond TIME literals in the monitor through the Worker", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.fill("PROGRAM Main VAR duration: TIME; END_VAR END_PROGRAM");
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const row = page
    .getByRole("region", { name: "Variable monitor", exact: true })
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: /^duration(?: Forced)?$/ }) });
  for (const [text, expected] of [
    ["T#1500us", "T#1ms"],
    ["TIME#-1500us", "T#-1ms"],
    ["T#500us", "T#0ms"],
    ["T#1ms500us", "T#1ms"],
  ] as const) {
    await row.getByLabel("Value to write").fill(text);
    await row.getByRole("button", { name: "Write", exact: true }).click();
    await expect(row.locator("td").nth(2)).toHaveText(expected);
  }
  await row.getByLabel("Value to write").fill("T#-1500000ns");
  await row.getByRole("button", { name: "Force", exact: true }).click();
  await expect(row).toHaveAttribute("data-forced", "true");
  await expect(row.locator("td").nth(2)).toHaveText("T#-1ms");
  await row.getByLabel("Value to write").fill("T#2147483647ms1us");
  await row.getByRole("button", { name: "Write", exact: true }).click();
  await expect(row.getByRole("alert")).toContainText("valid value");
  await expect(row.locator("td").nth(2)).toHaveText("T#-1ms");
});

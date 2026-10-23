import { expect, test } from "@playwright/test";

test("expands an array and forces and writes individual elements", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(`PROGRAM Main
VAR V : ARRAY[1..5] OF INT := [1,2,3(0)]; Sum, i : INT; END_VAR
Sum := 0;
FOR i := 1 TO 5 DO Sum := Sum + V[i]; END_FOR;
END_PROGRAM`);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const row = (name: string) =>
    monitor.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });
  const value = (name: string) => row(name).locator("td").nth(2);
  await expect(value("Sum")).toHaveText("3");
  await expect(row("V[1]")).toHaveCount(0);
  await monitor.getByRole("button", { name: "V", exact: true }).click();
  for (let i = 1; i <= 5; i++) await expect(row(`V[${i}]`)).toBeVisible();
  await expect(value("V[4]")).toHaveText("0");
  await row("V[2]").getByLabel("Value to write").fill("10");
  await row("V[2]").getByRole("button", { name: "Force", exact: true }).click();
  await expect(value("Sum")).toHaveText("11");
  await monitor.getByRole("button", { name: "V", exact: true }).click();
  await expect(row("V[1]")).toHaveCount(0);
  await expect(monitor.getByRole("row").filter({ hasText: "V[2]" })).toHaveAttribute(
    "data-forced",
    "true",
  );
  await expect(value("Sum")).toHaveText("11");
  await monitor.getByRole("button", { name: "V", exact: true }).click();
  await row("V[1]").getByLabel("Value to write").fill("4");
  await row("V[1]").getByRole("button", { name: "Write", exact: true }).click();
  await expect(value("Sum")).toHaveText("14");
  await expect(
    page.locator('.inline-values [data-type="INT"]').filter({ hasText: "14" }).first(),
  ).toBeVisible();
});

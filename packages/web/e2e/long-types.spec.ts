import { expect, test } from "@playwright/test";

test("writes and forces exact 64-bit monitor values through the Worker", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(`PROGRAM LongValues
VAR x: LINT; mirror: LINT; u: ULINT := 18446744073709551615;
 w: LWORD; t: LTIME := LT#1ms500us;
END_VAR
mirror := x;
END_PROGRAM`);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const row = (name: string) =>
    monitor.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: new RegExp(`^${name}(?: Forced)?$`) }),
    });
  await expect(row("u").locator("td").nth(2)).toHaveText("18446744073709551615");
  await expect(row("t").locator("td").nth(2)).toHaveText("LTIME#1ms500us");
  await row("x").getByLabel("Value to write").fill("9223372036854775807");
  await row("x").getByRole("button", { name: "Write", exact: true }).click();
  await expect(row("x").locator("td").nth(2)).toHaveText("9223372036854775807");
  await expect(row("mirror").locator("td").nth(2)).toHaveText("9223372036854775807");
  await row("x").getByLabel("Value to write").fill("-9223372036854775808");
  await row("x").getByRole("button", { name: "Force", exact: true }).click();
  await expect(row("x")).toHaveAttribute("data-forced", "true");
  await expect(row("mirror").locator("td").nth(2)).toHaveText("-9223372036854775808");
  await row("x").getByLabel("Value to write").fill("9223372036854775808");
  await row("x").getByRole("button", { name: "Write", exact: true }).click();
  await expect(row("x").getByRole("alert")).toContainText("valid value");
  await expect(row("x").locator("td").nth(2)).toHaveText("-9223372036854775808");
  await row("w").getByLabel("Value to write").fill("16#8000000000000001");
  await row("w").getByRole("button", { name: "Write", exact: true }).click();
  await expect(row("w").locator("td").nth(2)).toHaveText("16#8000000000000001");
  await row("t").getByLabel("Value to write").fill("LT#9007199254740993ns");
  await row("t").getByRole("button", { name: "Write", exact: true }).click();
  await expect(row("t").locator("td").nth(2)).toHaveText("LTIME#104d5h59m59s254ms740us993ns");
});

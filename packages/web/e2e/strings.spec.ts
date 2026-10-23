import { expect, test } from "@playwright/test";

test("writes and forces quoted strings through the Worker without confusing decimal text", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(`PROGRAM Messages
VAR msg : STRING[3] := '123'; numberValue : LINT := 123; mirrored : STRING[3]; ok : BOOL; END_VAR
mirrored := msg;
ok := msg = 'OK';
END_PROGRAM`);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const row = (name: string) =>
    monitor
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name: new RegExp(`^${name}(?: Forced)?$`) }) });
  const shown = (name: string) => row(name).locator("td").nth(2);
  await expect(shown("msg")).toHaveText("'123'");
  await expect(shown("numberValue")).toHaveText("123");
  await row("msg").getByLabel("Value to write").fill("'OK'");
  await row("msg").getByRole("button", { name: "Write", exact: true }).click();
  await expect(shown("ok")).toHaveText("TRUE");
  await expect(shown("mirrored")).toHaveText("'OK'");
  for (const action of ["Write", "Force"]) {
    for (const invalid of ["'long'", "'$Q'", "'Ā'"]) {
      await row("msg").getByLabel("Value to write").fill(invalid);
      await row("msg").getByRole("button", { name: action, exact: true }).click();
      await expect(row("msg").getByRole("alert")).toContainText("valid value");
      await expect(shown("msg")).toHaveText("'OK'");
      await expect(row("msg")).toHaveAttribute("data-forced", "false");
    }
  }
  await row("msg").getByLabel("Value to write").fill("'$31$32$33'");
  await row("msg").getByRole("button", { name: "Force", exact: true }).click();
  await expect(row("msg")).toHaveAttribute("data-forced", "true");
  await expect(shown("mirrored")).toHaveText("'123'");
  await expect(shown("ok")).toHaveText("FALSE");
  await expect(shown("numberValue")).toHaveText("123");
  await expect(
    page.locator('.inline-values [data-type="STRING"]').filter({ hasText: "'123'" }),
  ).toBeVisible();
});

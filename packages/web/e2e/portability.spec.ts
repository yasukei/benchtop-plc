import { expect, test } from "@playwright/test";

test("localizes portability warnings and runs typed and overloaded conversions", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(`PROGRAM Portability
VAR x: BYTE := 2; r: REAL := 1.0; b: BOOL; d: DWORD; END_VAR
b := BYTE_TO_BOOL(x);
d := TO_DWORD(r);
END_PROGRAM`);
  const diagnostics = page.getByRole("region", { name: "Diagnostics", exact: true });
  const bitWarning = diagnostics.getByRole("button", {
    name: "Portability: Line 3, column 6 BYTE_TO_BOOL returns the rightmost bit; some vendor runtimes return TRUE for any non-zero value.",
  });
  await expect(bitWarning).toBeVisible();
  await expect(diagnostics).toContainText(
    "REAL_TO_DWORD reinterprets the bit pattern; some vendor runtimes convert the numeric value instead.",
  );
  await expect(page.locator(".cm-lintRange-warning")).toHaveText([
    "BYTE_TO_BOOL(x)",
    "TO_DWORD(r)",
  ]);
  await expect(page.locator(".cm-lintRange-error")).toHaveCount(0);
  await bitWarning.click();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("BYTE_TO_BOOL(x)");

  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  for (const [name, value] of [
    ["b", "FALSE"],
    ["d", "16#3F800000"],
  ]) {
    const row = page.getByRole("row").filter({
      has: page.getByRole("rowheader", { name, exact: true }),
    });
    await expect(row.locator("td").nth(2)).toHaveText(value!);
  }

  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  const localized = page.getByRole("region", { name: "診断", exact: true });
  await expect(
    localized.getByRole("button", {
      name: /^Portability: 3行、6列 BYTE_TO_BOOLは最下位ビットを返します。/,
    }),
  ).toBeVisible();
  await expect(localized).toContainText("ゼロ以外のすべての値に対してTRUEを返します。");
  await expect(localized).toContainText("REAL_TO_DWORDはビットパターンを再解釈します。");
  await expect(localized).toContainText("代わりに数値を変換します。");
  await expect(page.locator(".cm-lintRange-warning")).toHaveCount(2);
});

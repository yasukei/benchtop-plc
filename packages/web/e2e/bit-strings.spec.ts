import { expect, test } from "@playwright/test";

test("shows the new types and writes and forces a WORD in IEC hexadecimal", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(`PROGRAM Bits
VAR s: SINT := -128; u: USINT := 255; ud: UDINT := 4294967295;
 b: BYTE := BYTE#16#FF; w: WORD; d: DWORD := DWORD#16#FFFFFFFF; mirror: WORD;
END_VAR
mirror := w;
END_PROGRAM`);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  for (const [name, value] of [
    ["s", "-128"],
    ["u", "255"],
    ["ud", "4294967295"],
    ["b", "16#FF"],
    ["d", "16#FFFFFFFF"],
  ]) {
    const row = monitor
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name, exact: true }) });
    await expect(row.locator("td").nth(2)).toHaveText(value!);
  }
  const word = monitor
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: /^w(?: Forced)?$/ }) });
  const mirror = monitor
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "mirror", exact: true }) });
  await word.getByLabel("Value to write").fill("16#00FF");
  await word.getByRole("button", { name: "Write", exact: true }).click();
  await expect(word.locator("td").nth(2)).toHaveText("16#00FF");
  await expect(mirror.locator("td").nth(2)).toHaveText("16#00FF");
  await word.getByLabel("Value to write").fill("2#1000_0000_0000_0000");
  await word.getByRole("button", { name: "Force", exact: true }).click();
  await expect(word).toHaveAttribute("data-forced", "true");
  await expect(mirror.locator("td").nth(2)).toHaveText("16#8000");
  for (const input of ["16#10000", "-1", "1.5"]) {
    await word.getByLabel("Value to write").fill(input);
    await word.getByRole("button", { name: "Force", exact: true }).click();
    await expect(word.getByRole("alert")).toContainText("valid value");
    await expect(word.locator("td").nth(2)).toHaveText("16#8000");
  }
  await word.getByRole("button", { name: "Unforce", exact: true }).click();
  await expect(word).toHaveAttribute("data-forced", "false");
  await word.getByLabel("Value to write").fill("16#1");
  await word.getByRole("button", { name: "Write", exact: true }).click();
  await expect(mirror.locator("td").nth(2)).toHaveText("16#0001");
});

test("runs bit access while a portability warning remains visible", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(`PROGRAM Bits
VAR w: WORD; b: BOOL; END_VAR
w.15 := TRUE;
b := WORD_TO_BOOL(w);
END_PROGRAM`);
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    "vendor runtimes",
  );
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const word = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "w", exact: true }) });
  await expect(word.locator("td").nth(2)).toHaveText("16#8000");
});

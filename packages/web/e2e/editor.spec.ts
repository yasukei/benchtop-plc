import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const reference = readFileSync(
  new URL("../../../tests/conformance/fixtures/reference.st", import.meta.url),
  "utf8",
);

async function replaceSource(page: Page, source: string) {
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  // Use CodeMirror's selection, rather than mutating the contenteditable DOM selection.
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(source);
  return editor;
}

test("shows localized diagnostics, selects their spans and clears them after fixing", async ({
  page,
}) => {
  await page.goto("/");
  const source = "PROGRAM Test\nVAR x: INT; END_VAR\nx := missing;\nEND_PROGRAM";
  const editor = await replaceSource(page, source);
  const diagnostics = page.getByRole("region", { name: "Diagnostics", exact: true });
  const diagnostic = diagnostics.getByRole("button", {
    name: "Line 3, column 6 Undeclared identifier: missing.",
  });
  await expect(diagnostic).toBeVisible();
  await expect(page.locator(".cm-lintRange-error")).toHaveText("missing");
  await diagnostic.click();
  await expect(editor).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("missing");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  const localized = page.getByRole("region", { name: "診断", exact: true });
  await expect(localized).toContainText("3行、6列");
  await expect(localized).toContainText("宣言されていない識別子です: missing。");
  await expect(page.getByRole("textbox", { name: "Structured Text", exact: true })).toHaveText(
    /x := missing;/,
  );
  await replaceSource(page, source.replace("missing", "1"));
  await expect(localized).toHaveText(/診断はありません/);
  await expect(page.locator(".cm-lintRange-error")).toHaveCount(0);
  await expect(page.getByText("未適用の変更あり", { exact: true })).toBeVisible();
});

test("runs the reference program with changing inline values and hides values for edited text", async ({
  page,
}) => {
  await page.goto("/");
  // The operator panel is a later issue. Drive the reference program's start signal in ST.
  const source = reference.replace("Running :=", "StartPB := TRUE;\nRunning :=");
  await replaceSource(page, source);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const timerLine = source.slice(0, source.indexOf("tBlinkOn(IN")).split("\n").length;
  const timer = page.locator(`.inline-values[data-line="${timerLine}"]`);
  await expect(timer.locator('[data-type="TIME"]')).toBeVisible();
  const firstValue = await timer.textContent();
  await expect.poll(() => timer.textContent()).not.toBe(firstValue);
  await expect(page.locator('.inline-values [data-type="BOOL"]').first()).toHaveText("TRUE");
  await expect(page.locator(".st-keyword").first()).toHaveText("PROGRAM");
  await expect(page.locator(".st-fb").first()).toHaveText("TON");
  await page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  await replaceSource(page, source + "\n// editing");
  await expect(page.getByText("Unapplied changes", { exact: true })).toBeVisible();
  await expect(page.locator(".inline-values")).toHaveCount(0);
  await replaceSource(page, source);
  await expect(timer).toBeVisible();
});

test("cold-starts edited code on RUN and preserves the running program when compilation fails", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  await replaceSource(
    page,
    "PROGRAM Changed\nVAR x: DINT := 100; END_VAR\nx := x + 1;\nEND_PROGRAM",
  );
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const values = page.locator('.inline-values[data-line="3"]');
  await expect.poll(async () => Number(await values.textContent())).toBeGreaterThan(100);
  await replaceSource(page, "PROGRAM Bad\nmissing := 1;\nEND_PROGRAM");
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    "Undeclared identifier",
  );
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  await expect(page.getByText("Unapplied changes", { exact: true })).toBeVisible();
  await page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true }).click();
  await expect(page.getByRole("button", { name: "Single scan", exact: true })).toBeDisabled();
});

test("uses spaces on Tab, indents Enter and preserves editor history through theme and language changes", async ({
  page,
}) => {
  await page.goto("/");
  const editor = await replaceSource(page, "PROGRAM Test\nVAR");
  await editor.press("ControlOrMeta+End");
  await editor.press("Enter");
  await editor.press("Tab");
  await editor.pressSequentially("x: INT;");
  await expect(editor.locator(".cm-line").nth(2)).toHaveText("    x: INT;");
  expect(await editor.textContent()).not.toContain("\t");
  await editor.press("ControlOrMeta+Home");
  await editor.pressSequentially("X");
  await page.getByLabel("Theme").selectOption("dark");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(editor.locator(".cm-line").first()).toHaveText("XPROGRAM Test");
  await editor.press("ControlOrMeta+z");
  await expect(editor.locator(".cm-line").first()).toHaveText("PROGRAM Test");
});

test("Tab indents selected lines without replacing code and Shift-Tab restores them", async ({
  page,
}) => {
  await page.goto("/");
  const lines = ["PROGRAM Test", "VAR x: INT; END_VAR", "x := x + 1;", "END_PROGRAM"];
  const editor = await replaceSource(page, lines.join("\n"));
  await editor.press("ControlOrMeta+a");
  await editor.press("Tab");
  await expect
    .poll(() => editor.locator(".cm-line").allTextContents())
    .toEqual(lines.map((line) => `  ${line}`));
  expect(await editor.textContent()).not.toContain("\t");
  await editor.press("Shift+Tab");
  await expect.poll(() => editor.locator(".cm-line").allTextContents()).toEqual(lines);
});

test("highlights a real runtime fault line only while its source matches", async ({ page }) => {
  await page.goto("/");
  await replaceSource(page, "PROGRAM Fault\nVAR x: INT; END_VAR\nx := 1 / x;\nEND_PROGRAM");
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("FAULT");
  await expect(page.locator(".runtime-fault-line")).toContainText("x := 1 / x;");
  const diagnostics = page.getByRole("region", { name: "Diagnostics", exact: true });
  await expect(diagnostics).toContainText("Line 3");
  await expect(diagnostics).toContainText("Division by zero.");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(page.getByRole("region", { name: "診断", exact: true })).toContainText(
    "ゼロによる除算が発生しました。",
  );
  await page.getByRole("combobox", { name: "言語", exact: true }).selectOption("en");
  await replaceSource(page, "PROGRAM Fixed END_PROGRAM");
  await expect(page.locator(".runtime-fault-line")).toHaveCount(0);
  await page.getByRole("button", { name: "Cold reset", exact: true }).click();
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  await expect(page.locator(".runtime-fault-line")).toHaveCount(0);
});

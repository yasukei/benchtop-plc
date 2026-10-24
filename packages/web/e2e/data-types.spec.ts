import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject } from "@benchtop-plc/project";

const type = "TYPE State : (Idle, Running, Done); END_TYPE";
const main = "PROGRAM Main\nVAR phase : State; END_VAR\nphase := State#Running;\nEND_PROGRAM";

test("adds an enum, runs by name, and preserves type text through autosave and XML", async ({
  page,
}) => {
  await page.goto("/");
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: "Add data type", exact: true }).click();
  await expect(editor).toContainText("TYPE Type1");
  await editor.fill(type);
  await expect(list.getByRole("button", { name: /^State TYPE/ })).toContainText("Diagnostics: 0");
  await list.getByRole("button", { name: /^Main PROGRAM/ }).click();
  await editor.fill(main);
  await expect(editor.locator(".st-type").filter({ hasText: /^State$/ })).not.toHaveCount(0);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "phase", exact: true }) });
  await expect(row.locator("td").nth(2)).toHaveText("Running");
  await expect(page.locator(".inline-values")).toContainText("Running");
  const line = editor.locator(".cm-line").filter({ hasText: /^phase :=/ });
  await line.scrollIntoViewIfNeeded();
  const point = await line.evaluate((element) => {
    const text = element.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error("Expected variable text");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, "phase".length);
    const rect = range.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await expect(page.locator(".cm-tooltip-hover")).toHaveText("phase: State");
  await page
    .getByRole("region", { name: "Runtime controls", exact: true })
    .getByRole("button", { name: "STOP", exact: true })
    .click();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  await list.getByRole("button", { name: /^State TYPE/ }).click();
  await expect(page.locator(".inline-values")).toHaveCount(0);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const xml = readFileSync((await (await download).path())!, "utf8");
  expect(readProject(xml).value).toMatchObject({ dataTypes: [type], pous: [main] });
  await page.reload();
  await expect(editor.locator(".cm-line")).toHaveText([type]);
  await expect(list.getByRole("button", { name: /^State TYPE/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page
    .getByLabel("Open project", { exact: true })
    .setInputFiles({ name: "types.xml", mimeType: "application/xml", buffer: Buffer.from(xml) });
  await expect(editor.locator(".cm-line")).toHaveText(main.split("\n"));
  await list.getByRole("button", { name: /^State TYPE/ }).click();
  await expect(editor.locator(".cm-line")).toHaveText([type]);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  await expect(row.locator("td").nth(2)).toHaveText("Running");
});

test("navigates type diagnostics, retains damaged names, and confirms type deletion", async ({
  page,
}) => {
  await page.goto("/");
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  const problems = page.getByRole("region", { name: "Diagnostics", exact: true });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: "Add data type", exact: true }).click();
  await editor.fill(type);
  await editor.fill("TYPE State : Missing; END_TYPE");
  await expect(list.getByRole("button", { name: /^State TYPE/ })).toContainText("Diagnostics: 1");
  await list.getByRole("button", { name: /^Main PROGRAM/ }).click();
  await expect(page.locator(".cm-lintRange-error")).toHaveCount(0);
  await problems.getByRole("button").filter({ hasText: "Missing" }).click();
  await expect(editor).toContainText("TYPE State : Missing");
  await expect(page.locator(".cm-lintRange-error")).not.toHaveCount(0);
  await editor.fill("TYPE");
  await expect(list.getByRole("button", { name: /^State TYPE/ })).toContainText("Diagnostics: 1");
  await page.reload();
  await expect(editor).toHaveText("TYPE");
  await expect(list.getByRole("button", { name: /^State TYPE/ })).toBeVisible();
  await editor.fill(type);
  await list.getByRole("button", { name: /^Main PROGRAM/ }).click();
  await editor.fill(main);
  await list.getByRole("button", { name: "Delete State", exact: true }).click();
  await list.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(list.getByRole("button", { name: /^State TYPE/ })).toBeVisible();
  await list.getByRole("button", { name: "Delete State", exact: true }).click();
  await list.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(list.getByRole("button", { name: /^Main PROGRAM/ })).toContainText("Diagnostics: 3");
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const xml = readFileSync((await (await download).path())!, "utf8");
  await page
    .getByLabel("Open project", { exact: true })
    .setInputFiles({ name: "missing.xml", mimeType: "application/xml", buffer: Buffer.from(xml) });
  await expect(problems).toContainText("State");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(page.getByRole("button", { name: "データ型を追加", exact: true })).toBeVisible();
});

test("explains recursive type cycles in both languages", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const list = page.getByRole("region", { name: "POUs", exact: true });
  await list.getByRole("button", { name: "Add data type", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Structured Text", exact: true })
    .fill("TYPE Node : STRUCT next : Node; END_STRUCT; END_TYPE");
  await expect(list.getByRole("button", { name: /^Node TYPE/ })).toContainText("Diagnostics: 1");
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    "Type Node has a containment or alias cycle; use REF_TO for recursive links.",
  );
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(page.getByRole("region", { name: "診断", exact: true })).toContainText(
    "型Nodeの包含関係または別名定義が循環しています。再帰的なリンクにはREF_TOを使用してください。",
  );
});

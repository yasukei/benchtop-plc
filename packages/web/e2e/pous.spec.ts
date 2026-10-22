import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject, writeProject } from "@benchtop-plc/project";

const main = "PROGRAM Main\nVAR result : INT; END_VAR\nresult := F1(21);\nEND_PROGRAM";
const fn = "FUNCTION F1 : INT\nVAR_INPUT n : INT; END_VAR\nF1 := n * 2;\nEND_FUNCTION";

test("adds a function, runs its call, saves and restores three POUs with their texts", async ({
  page,
}) => {
  await page.goto("/");
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await expect(list.getByRole("button", { name: "Delete Main", exact: true })).toBeDisabled();
  await list.getByRole("button", { name: "Add function", exact: true }).click();
  await expect(editor).toContainText("FUNCTION F1 : INT");
  await editor.fill(fn);
  await list.getByRole("button", { name: /^Main PROGRAM/ }).click();
  await editor.fill(main);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "result", exact: true }) });
  await expect(row.getByText("42", { exact: true })).toBeVisible();
  await page
    .getByRole("region", { name: "Runtime controls", exact: true })
    .getByRole("button", { name: "STOP", exact: true })
    .click();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  await list.getByRole("button", { name: /^F1 FUNCTION/ }).click();
  await expect(page.locator(".inline-values")).toHaveCount(0);
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: "Add function", exact: true }).click();
  const third = (await editor.locator(".cm-line").allTextContents()).join("\n");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const xml = readFileSync((await (await downloadPromise).path())!, "utf8");
  expect(readProject(xml).value!.pous).toEqual([main, fn, third]);
  await page.reload();
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(editor).toContainText("FUNCTION F2");
  await list.getByRole("button", { name: /^F1 FUNCTION/ }).click();
  await expect(editor.locator(".cm-line")).toHaveText(fn.split("\n"));
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "functions.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await expect(editor.locator(".cm-line")).toHaveText(main.split("\n"));
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await list.getByRole("button", { name: /^F2 FUNCTION/ }).click();
  await expect(editor).toContainText("FUNCTION F2");
});

test("confirms deletion, navigates cross-POU diagnostics, and saves missing-call errors", async ({
  page,
}) => {
  await page.goto("/");
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  const problems = page.getByRole("region", { name: "Diagnostics", exact: true });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await editor.fill(main);
  await list.getByRole("button", { name: "Add function", exact: true }).click();
  await editor.fill(fn);
  await list.getByRole("button", { name: "Delete F1", exact: true }).click();
  await list.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await list.getByRole("button", { name: "Delete F1", exact: true }).click();
  await list.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(problems).toContainText("F1");
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const xml = readFileSync((await (await downloadPromise).path())!, "utf8");
  await page
    .getByLabel("Open project", { exact: true })
    .setInputFiles({ name: "missing.xml", mimeType: "application/xml", buffer: Buffer.from(xml) });
  await expect(problems).toContainText("F1");
  await list.getByRole("button", { name: "Add function", exact: true }).click();
  await editor.fill("FUNCTION F1 : INT\nVAR_INPUT n : INT; END_VAR\nF1 := unknown;\nEND_FUNCTION");
  await expect(problems).toContainText("unknown");
  await list.getByRole("button", { name: /^Main PROGRAM/ }).click();
  await expect(page.locator(".cm-lintRange-error")).toHaveCount(0);
  await problems.getByRole("button").filter({ hasText: "unknown" }).click();
  await expect(editor).toContainText("FUNCTION F1");
  await expect(page.locator(".cm-lintRange-error")).not.toHaveCount(0);
  await editor.fill("FUNCTION");
  await expect(list.getByRole("button", { name: /^F1 FUNCTION/ })).toContainText("Diagnostics: 1");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Unexpected end of input");
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "broken.xml",
    mimeType: "application/xml",
    buffer: Buffer.from("invalid XML"),
  });
  await expect(page.getByRole("alert")).not.toContainText("Unexpected end of input");
  await page.reload();
  await expect(editor).toHaveText("FUNCTION");
  await expect(list.getByRole("button", { name: /^F1 FUNCTION/ })).toContainText("Diagnostics: 1");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(page.getByRole("button", { name: "関数を追加", exact: true })).toBeVisible();
});

test("edits an empty project and the empty list after deleting its last function", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  const list = page.getByRole("region", { name: "POUs", exact: true });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const project = readProject(readFileSync((await (await downloadPromise).path())!, "utf8")).value!;
  const empty = writeProject({ ...project, pous: [] }).value!;
  await page
    .getByLabel("Open project", { exact: true })
    .setInputFiles({ name: "empty.xml", mimeType: "application/xml", buffer: Buffer.from(empty) });
  await expect(list.getByRole("listitem")).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(editor).toHaveText("");
  await editor.fill("PROGRAM Fresh END_PROGRAM");
  await expect(list.getByRole("button", { name: /^Fresh PROGRAM/ })).toBeVisible();
  await editor.fill("FUNCTION Last END_FUNCTION");
  await list.getByRole("button", { name: "Delete Last", exact: true }).click();
  await list.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(list.getByRole("listitem")).toHaveCount(0);
  await expect(editor).toBeVisible();
  await expect(editor).toHaveText("");
  await editor.fill("PROGRAM Recovered END_PROGRAM");
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
});

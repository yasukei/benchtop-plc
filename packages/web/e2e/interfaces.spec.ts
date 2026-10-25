import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject } from "@benchtop-plc/project";

test("adds an interface, monitors its target and preserves save/reopen", async ({ page }) => {
  const face = "INTERFACE IActuator\nMETHOD Start END_METHOD\nEND_INTERFACE";
  const valve = "CLASS Valve IMPLEMENTS IActuator\nMETHOD PUBLIC Start END_METHOD\nEND_CLASS";
  const main = "PROGRAM Main\nVAR v: Valve; a: IActuator; END_VAR\na := v; a.Start();\nEND_PROGRAM";
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await list.getByRole("button", { name: "Add interface", exact: true }).click();
  await expect(editor).toContainText("INTERFACE I1");
  await expect(editor).toContainText("METHOD Run");
  await editor.fill(face);
  await list.getByRole("button", { name: "Add class", exact: true }).click();
  await editor.fill(valve);
  await list.getByRole("button", { name: /^Main PROGRAM/ }).click();
  await editor.fill(main);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const row = monitor
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "a", exact: true }) });
  await expect(row).toBeVisible();
  await expect(row.locator("td").nth(2)).toHaveText("mainInstance.V");
  await expect(row.getByRole("button")).toHaveCount(0);
  await page
    .getByRole("region", { name: "Runtime controls", exact: true })
    .getByRole("button", { name: "STOP", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const xml = readFileSync((await (await download).path())!, "utf8");
  expect(readProject(xml).value?.pous).toEqual([face, main, valve]);
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "interfaces.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await list.getByRole("button", { name: /^IActuator INTERFACE/ }).click();
  await expect(editor.locator(".cm-line")).toHaveText(face.split("\n"));
});

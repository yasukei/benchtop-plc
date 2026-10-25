import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject } from "@benchtop-plc/project";

test("adds a class, calls its methods, monitors private state and preserves save/reopen", async ({
  page,
}) => {
  const main =
    "PROGRAM Main\nVAR v: Valve; seen: BOOL; END_VAR\nv.Open(); seen := v.IsOpen();\nEND_PROGRAM";
  const valve = `CLASS Valve
VAR PRIVATE opened: BOOL; END_VAR
METHOD PUBLIC Open THIS.opened := TRUE; END_METHOD
METHOD PUBLIC Close THIS.opened := FALSE; END_METHOD
METHOD PUBLIC IsOpen : BOOL IsOpen := opened; END_METHOD
END_CLASS`;
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await list.getByRole("button", { name: "Add class", exact: true }).click();
  await expect(editor).toContainText("CLASS Class1");
  await expect(editor).toContainText("METHOD PUBLIC Run");
  await editor.fill(valve);
  await list.getByRole("button", { name: /^Main PROGRAM/ }).click();
  await editor.fill(main);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const member = monitor
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: /^V\.OPENED/ }) });
  await expect(member).toBeVisible();
  await expect(member.locator("td").nth(2)).toHaveText("TRUE");
  await member.getByRole("button", { name: "Force FALSE", exact: true }).click();
  await expect(member).toHaveAttribute("data-forced", "true");
  await expect(member.locator("td").nth(2)).toHaveText("FALSE");
  await page
    .getByRole("region", { name: "Runtime controls", exact: true })
    .getByRole("button", { name: "STOP", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const xml = readFileSync((await (await download).path())!, "utf8");
  expect(readProject(xml).value?.pous).toEqual([main, valve]);
  await page.reload();
  await list.getByRole("button", { name: /^Valve CLASS/ }).click();
  await expect(editor.locator(".cm-line")).toHaveText(valve.split("\n"));
  await page
    .getByLabel("Open project", { exact: true })
    .setInputFiles({ name: "classes.xml", mimeType: "application/xml", buffer: Buffer.from(xml) });
  await list.getByRole("button", { name: /^Valve CLASS/ }).click();
  await expect(editor.locator(".cm-line")).toHaveText(valve.split("\n"));
});

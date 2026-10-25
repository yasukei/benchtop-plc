import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject } from "@benchtop-plc/project";

test("monitors class references, executes methods and preserves save/reopen", async ({ page }) => {
  const valve = `CLASS Valve
VAR PUBLIC count: INT; END_VAR
METHOD PUBLIC Open count := count + 1; END_METHOD
END_CLASS`;
  const main = `PROGRAM Main
VAR v: Valve; r: REF_TO Valve; observed: INT; END_VAR
r := REF(v); r^.Open(); observed := r^.count;
END_PROGRAM`;
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await list.getByRole("button", { name: "Add class", exact: true }).click();
  await editor.fill(valve);
  await list.getByRole("button", { name: /^Main PROGRAM/ }).click();
  await editor.fill(main);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  await page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true }).click();
  await page.getByRole("button", { name: "Cold reset", exact: true }).click();
  await expect(page.getByLabel("Scans", { exact: true })).toHaveText("0");
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const row = (name: string) =>
    monitor.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });
  await expect(row("r").locator("td").nth(2)).toHaveText("mainInstance.V");
  await expect(row("r").getByRole("button")).toHaveCount(0);
  await expect(row("observed").locator("td").nth(2)).toHaveText("1");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const xml = readFileSync((await (await download).path())!, "utf8");
  expect(readProject(xml).value?.pous).toEqual([main, valve]);
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "instance-references.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await expect(editor.locator(".cm-line")).toHaveText(main.split("\n"));
  await expect(row("r").locator("td").nth(2)).toHaveText("NULL");
});

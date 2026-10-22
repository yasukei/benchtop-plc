import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject } from "@benchtop-plc/project";

test("runs both motor starters, lists their POUs and preserves their texts on save/reopen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const xml = readFileSync(
    new URL("../../../examples/motor-starters/project.xml", import.meta.url),
    "utf8",
  );
  const original = readProject(xml).value!;
  await page.goto("/");
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "motor-starters.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const problems = page.getByRole("region", { name: "Diagnostics", exact: true });
  await expect(problems).toContainText("No diagnostics");
  const list = page.getByRole("region", { name: "POUs", exact: true });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(list.getByRole("button", { name: /^Main PROGRAM/ })).toBeVisible();
  await expect(list.getByRole("button", { name: /^MotorStarter FUNCTION_BLOCK/ })).toBeVisible();
  await expect(list.getByRole("button", { name: /^CanStart FUNCTION/ })).toBeVisible();

  const panel = page.getByRole("region", { name: "Operator panel", exact: true });
  await expect(panel.locator(".positioned-part")).toHaveCount(12);
  const run1 = panel.getByRole("status", { name: "M1 RUN", exact: true });
  const run2 = panel.getByRole("status", { name: "M2 RUN", exact: true });
  await expect(run1).toHaveAttribute("data-on", "false");
  await expect(run2).toHaveAttribute("data-on", "false");
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const start1 = panel.getByRole("button", { name: "M1 START", exact: true });
  await start1.focus();
  await page.keyboard.down("Space");
  await expect(run1).toHaveAttribute("data-on", "true");
  await page.keyboard.up("Space");
  await expect(run2).toHaveAttribute("data-on", "false");

  await panel.getByRole("button", { name: "M1 STOP", exact: true }).focus();
  await page.keyboard.down("Space");
  await expect(run1).toHaveAttribute("data-on", "false");
  await page.keyboard.up("Space");
  await panel.getByRole("button", { name: "M2 START", exact: true }).focus();
  await page.keyboard.down("Space");
  await expect(run2).toHaveAttribute("data-on", "true");
  await page.keyboard.up("Space");
  await panel.getByRole("switch", { name: "M2 OVERLOAD", exact: true }).click();
  await expect(run2).toHaveAttribute("data-on", "false");
  await expect(panel.getByRole("status", { name: "M2 TRIP", exact: true })).toHaveAttribute(
    "data-on",
    "true",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page
    .getByRole("region", { name: "Runtime controls", exact: true })
    .getByRole("button", { name: "STOP", exact: true })
    .click();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const savedXml = readFileSync((await (await downloadPromise).path())!, "utf8");
  const saved = readProject(savedXml);
  expect(saved.diagnostics).toEqual([]);
  expect(saved.value!.pous).toEqual(original.pous);
  expect(saved.value!.panel).toEqual(original.panel);
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "saved-motor-starters.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(savedXml),
  });
  await expect(problems).toContainText("No diagnostics");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  for (const [index, name] of [
    "Main PROGRAM",
    "MotorStarter FUNCTION_BLOCK",
    "CanStart FUNCTION",
  ].entries()) {
    await list.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    await expect(editor.locator(".cm-line")).toHaveText(original.pous[index]!.split("\n"));
  }
});

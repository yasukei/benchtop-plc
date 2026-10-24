import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject } from "@benchtop-plc/project";

test("runs the batch mixer and preserves its type and program texts on save/reopen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const xml = readFileSync(
    new URL("../../../examples/batch-mixer/project.xml", import.meta.url),
    "utf8",
  );
  const original = readProject(xml).value!;
  await page.goto("/");
  const open = page.getByLabel("Open project", { exact: true });
  await open.setInputFiles({
    name: "batch-mixer.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const problems = page.getByRole("region", { name: "Diagnostics", exact: true });
  await expect(problems).toContainText("No diagnostics");
  const list = page.getByRole("region", { name: "POUs", exact: true });
  for (const name of ["MixerState TYPE", "Recipe TYPE", "Main PROGRAM"]) {
    await expect(list.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();
  }

  const panel = page.getByRole("region", { name: "Operator panel", exact: true });
  await expect(panel.locator(".positioned-part")).toHaveCount(8);
  const lamp = (name: string) => panel.getByRole("status", { name, exact: true });
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const value = (name: string) =>
    monitor
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name, exact: true }) })
      .locator("td")
      .nth(2);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  await expect(page.getByLabel("Scans", { exact: true })).not.toHaveText("0");
  // Select Quick by leaving both recipe switches OFF.
  await panel.getByRole("button", { name: "START", exact: true }).focus();
  await page.keyboard.down("Space");
  await expect(lamp("FILL VALVE")).toHaveAttribute("data-on", "true");
  await page.keyboard.up("Space");
  await expect(value("State")).toHaveText("Filling");
  await expect(value("ActiveRecipe")).toHaveText("RECIPES[1]");
  await expect(value("Status")).toHaveText("'Quick: Filling'");
  await expect(lamp("MIXER")).toHaveAttribute("data-on", "true");
  await expect(lamp("FILL VALVE")).toHaveAttribute("data-on", "false");
  await expect(value("State")).toHaveText("Mixing");
  await expect(value("Status")).toHaveText("'Quick: Mixing'");
  await expect(lamp("DRAIN VALVE")).toHaveAttribute("data-on", "true");
  await expect(lamp("MIXER")).toHaveAttribute("data-on", "false");
  await expect(value("State")).toHaveText("Draining");
  await expect(value("Status")).toHaveText("'Quick: Draining'");
  await expect(lamp("DONE")).toHaveAttribute("data-on", "true");
  await expect(lamp("DRAIN VALVE")).toHaveAttribute("data-on", "false");
  await expect(value("State")).toHaveText("Done");
  await expect(value("Status")).toHaveText("'Quick: Done'");

  await panel.getByRole("button", { name: "STOP", exact: true }).focus();
  await page.keyboard.down("Space");
  await expect(lamp("DONE")).toHaveAttribute("data-on", "false");
  await page.keyboard.up("Space");
  await expect(value("State")).toHaveText("Idle");
  await expect(value("Status")).toHaveText("'Idle'");
  await expect(value("ActiveRecipe")).toHaveText("NULL");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page
    .getByRole("region", { name: "Runtime controls", exact: true })
    .getByRole("button", { name: "STOP", exact: true })
    .click();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const savedXml = readFileSync((await (await download).path())!, "utf8");
  const saved = readProject(savedXml);
  expect(saved.diagnostics).toEqual([]);
  expect(saved.value!.dataTypes).toEqual(original.dataTypes);
  expect(saved.value!.pous).toEqual(original.pous);
  expect(saved.value!.panel).toEqual(original.panel);
  await open.setInputFiles({
    name: "saved-batch-mixer.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(savedXml),
  });
  await expect(problems).toContainText("No diagnostics");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  for (const [index, name] of ["MixerState TYPE", "Recipe TYPE", "Main PROGRAM"].entries()) {
    await list.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    if (index < original.dataTypes.length) {
      await expect(editor.locator(".cm-line")).toHaveText(original.dataTypes[index]!.split("\n"));
    } else {
      // CodeMirror only renders the visible portion of this longer program.
      await expect(editor.locator(".cm-line").first()).toHaveText("PROGRAM Main");
      await editor.press("ControlOrMeta+End");
      await expect(editor.locator(".cm-line").filter({ hasText: /^END_PROGRAM$/ })).toBeVisible();
    }
  }
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  const reopenedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const reopened = readProject(readFileSync((await (await reopenedDownload).path())!, "utf8"));
  expect(reopened.diagnostics).toEqual([]);
  expect(reopened.value!.dataTypes).toEqual(original.dataTypes);
  expect(reopened.value!.pous).toEqual(original.pous);
  expect(reopened.value!.panel).toEqual(original.panel);
});

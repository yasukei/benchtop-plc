import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject, writeProject } from "@benchtop-plc/project";

// Exercise the public project codec as well as the editor/worker boundary.
test("runs inheritance, monitors base-first private members and preserves save/reopen", async ({
  page,
}) => {
  const main = "PROGRAM Main\nVAR d: Derived; seen: INT; END_VAR\nseen := d.Start();\nEND_PROGRAM";
  const base = `CLASS ABSTRACT Base
VAR PRIVATE hidden: INT := 7; END_VAR
VAR PUBLIC Speed: INT := 2; END_VAR
METHOD PUBLIC Start: INT Start := THIS.Check(Step := Speed); END_METHOD
METHOD PROTECTED ABSTRACT Check: INT VAR_INPUT Step: INT; END_VAR END_METHOD
END_CLASS`;
  const derived = `CLASS FINAL Derived EXTENDS Base
VAR own: INT := 3; END_VAR
METHOD PROTECTED FINAL OVERRIDE Check: INT
VAR scratch: INT := 20; END_VAR
VAR_INPUT Step: INT; END_VAR
Check := Step + own + scratch - 20; END_METHOD
END_CLASS`;
  const project = {
    fileHeader: {
      companyName: "",
      productName: "benchtop-plc",
      productVersion: "0.6.0",
      creationDateTime: "2026-10-25T00:00:00Z",
    },
    contentHeader: { name: "Inheritance" },
    pous: [main, base, derived],
    dataTypes: [],
    configuration: "Config",
    resource: "Res",
    task: { name: "Cyclic", interval: "PT0.01S", priority: 1 },
    instance: { name: "mainInstance", typeName: "Main" },
    panel: [],
  };
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "inheritance.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(saved.value!),
  });
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await list.getByRole("button", { name: /^Base CLASS/ }).click();
  await expect(editor.locator(".cm-line")).toHaveText(base.split("\n"));
  await list.getByRole("button", { name: /^Derived CLASS/ }).click();
  await expect(editor.locator(".cm-line")).toHaveText(derived.split("\n"));
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const row = (name: string) =>
    monitor.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: new RegExp(`^${name}`) }),
    });
  await expect(row("seen").locator("td").nth(2)).toHaveText("5");
  await expect(row("D\\.HIDDEN").locator("td").nth(2)).toHaveText("7");
  const labels = await monitor.getByRole("rowheader").allTextContents();
  expect(labels.findIndex((name) => name.startsWith("D.HIDDEN"))).toBeLessThan(
    labels.findIndex((name) => name.startsWith("D.SPEED")),
  );
  expect(labels.findIndex((name) => name.startsWith("D.SPEED"))).toBeLessThan(
    labels.findIndex((name) => name.startsWith("D.OWN")),
  );
  await page
    .getByRole("region", { name: "Runtime controls", exact: true })
    .getByRole("button", { name: "STOP", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const xml = readFileSync((await (await download).path())!, "utf8");
  expect(readProject(xml).value?.pous).toEqual(project.pous);
  await page.reload();
  await expect(list.getByRole("button", { name: /^Derived CLASS/ })).toBeVisible();
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "inheritance-reopened.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await list.getByRole("button", { name: /^Derived CLASS/ }).click();
  await expect(editor.locator(".cm-line")).toHaveText(derived.split("\n"));
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(row("seen").locator("td").nth(2)).toHaveText("5");
});

test("reports a base declaration error once and selects its declaring source", async ({ page }) => {
  const base = "CLASS Base\nVAR\nx: Missing; END_VAR\nEND_CLASS";
  const derived = "CLASS Derived EXTENDS Base END_CLASS";
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await list.getByRole("button", { name: "Add class", exact: true }).click();
  await editor.fill(base);
  await list.getByRole("button", { name: "Add class", exact: true }).click();
  await editor.fill(derived);
  const diagnostics = page.getByRole("region", { name: "Diagnostics", exact: true });
  await expect(diagnostics.getByRole("button")).toHaveCount(1);
  await expect(diagnostics.getByRole("button")).toContainText("Base:");
  await expect(list.getByRole("button", { name: /^Derived CLASS/ })).toContainText(
    "Diagnostics: 0",
  );
  await expect(page.locator(".cm-lintRange-error")).toHaveCount(0);
  await diagnostics.getByRole("button").click();
  await expect(editor.locator(".cm-line")).toHaveText(base.split("\n"));
  await expect(page.locator(".cm-lintRange-error")).toHaveText("Missing");
});

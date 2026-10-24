import { expect, test } from "@playwright/test";

test("groups implicit instance paths and names the instance supplying inline values", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const instance = monitor.getByRole("button", { name: "mainInstance", exact: true });
  await expect(instance).toHaveAttribute("aria-expanded", "true");
  await expect(monitor.getByRole("rowheader", { name: "Lamp", exact: true })).toHaveAttribute(
    "title",
    "mainInstance.Lamp",
  );
  await expect(page.getByText("Instance: mainInstance", { exact: true })).toBeVisible();
  await instance.click();
  await expect(monitor.getByRole("rowheader", { name: "Lamp", exact: true })).toHaveCount(0);
  await instance.click();
  await expect(monitor.getByRole("rowheader", { name: "Lamp", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(page.locator(".inline-values").first()).toBeVisible();
});

for (const multiple of [false, true]) {
  test(`opens, autosaves and resaves configuration sources with multiple tasks=${multiple}`, async ({
    page,
  }) => {
    const { readFileSync } = await import("node:fs");
    const { readProject, writeProject } = await import("@benchtop-plc/project");
    const { autosaveStorageKey } = await import("../src/autosave.js");
    const project = readProject(
      readFileSync(new URL("../../../examples/blink/project.xml", import.meta.url), "utf8"),
    ).value!;
    const configurationSource = `// exact configuration text\r
CONFIGURATION Plant RESOURCE Station ON Cpu\r
TASK Fast (INTERVAL := T#200ms, PRIORITY := 0);\r
${multiple ? "TASK Slow (INTERVAL := T#100ms, PRIORITY := 1);" : ""}\r
PROGRAM A WITH Fast : Main;\r
PROGRAM B WITH Fast : Main;\r
END_RESOURCE END_CONFIGURATION\r
`;
    project.configurationSource = configurationSource;
    await page.goto("/");
    await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
    await page.getByLabel("Open project", { exact: true }).setInputFiles({
      name: "configuration.xml",
      mimeType: "application/xml",
      buffer: Buffer.from(writeProject(project).value!),
    });
    const diagnostics = page.getByRole("region", { name: "Diagnostics", exact: true });
    if (multiple) {
      await expect(diagnostics).toContainText("A resource requires exactly one cyclic task.");
      await expect(page.getByRole("button", { name: "Single scan", exact: true })).toBeDisabled();
    } else {
      await expect(diagnostics).toContainText("No diagnostics");
      await expect(page.getByText("Instance: A", { exact: true })).toBeVisible();
      const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
      await expect(monitor.getByRole("button", { name: "A", exact: true })).toBeVisible();
      await expect(monitor.getByRole("button", { name: "B", exact: true })).toBeVisible();
    }
    await expect(page.getByLabel("Cycle (ms)")).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "null")?.project?.configurationSource,
          autosaveStorageKey,
        ),
      )
      .toBe(configurationSource);
    await page.reload();
    await expect(diagnostics).toContainText(
      multiple ? "A resource requires exactly one cyclic task." : "No diagnostics",
    );
    await expect(page.getByLabel("Cycle (ms)")).toHaveCount(0);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save project", exact: true }).click();
    const download = await downloadPromise;
    expect(
      readProject(readFileSync((await download.path())!, "utf8")).value?.configurationSource,
    ).toBe(configurationSource);
    const restore = page.getByRole("button", { name: "Restore example", exact: true });
    await restore.click();
    await restore.click();
    await expect(page.getByText("Instance: mainInstance", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Cycle (ms)")).toBeEnabled();
    await expect(diagnostics).toContainText("No diagnostics");
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}

test("forces a shared global in the globals group and preserves declarations on save", async ({
  page,
}) => {
  const { readFileSync } = await import("node:fs");
  const { readProject, writeProject } = await import("@benchtop-plc/project");
  const project = readProject(
    readFileSync(new URL("../../../examples/blink/project.xml", import.meta.url), "utf8"),
  ).value!;
  project.pous = [
    "PROGRAM Writer VAR_EXTERNAL gCount : INT; END_VAR gCount := gCount + 1; END_PROGRAM",
    "PROGRAM Reader VAR_EXTERNAL gCount : INT; END_VAR VAR seen : INT; END_VAR seen := gCount; END_PROGRAM",
  ];
  project.configurationSource = `CONFIGURATION Plant
VAR_GLOBAL CONSTANT cLimit : INT := 100; END_VAR
VAR_GLOBAL gCount : INT := 7; END_VAR
RESOURCE Station ON Cpu TASK T (INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM A WITH T : Writer; PROGRAM B WITH T : Reader;
END_RESOURCE END_CONFIGURATION`;
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "globals.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(writeProject(project).value!),
  });
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    "No diagnostics",
  );
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const group = monitor.getByRole("button", { name: "Globals", exact: true });
  await expect(group).toHaveAttribute("aria-expanded", "true");
  const global = monitor.getByRole("row").filter({ has: page.locator('th[title="gCount"]') });
  await expect(global).toContainText("7");
  await global.getByRole("textbox", { name: "Value to write" }).fill("42");
  await global.getByRole("button", { name: "Force", exact: true }).click();
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(global).toHaveAttribute("data-forced", "true");
  await expect(global).toContainText("42");
  const seen = monitor
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "seen", exact: true }) });
  await expect(seen).toContainText("42");
  await group.click();
  await expect(group).toHaveAttribute("aria-expanded", "false");
  await expect(global).toBeVisible();
  await group.click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const download = await downloadPromise;
  const reopened = readProject(readFileSync((await download.path())!, "utf8"));
  expect(reopened.diagnostics).toEqual([]);
  expect(reopened.value!.configurationSource).toBe(project.configurationSource);
  expect(reopened.value!.pous).toEqual(project.pous);
});

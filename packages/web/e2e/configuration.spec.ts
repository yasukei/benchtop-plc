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
  await expect(page.getByRole("combobox", { name: "Instance", exact: true })).toHaveValue(
    "mainInstance",
  );
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
PROGRAM B WITH ${multiple ? "Slow" : "Fast"} : Main;\r
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
    await expect(diagnostics).toContainText("Output writers overlap");
    await expect(page.getByRole("combobox", { name: "Instance", exact: true })).toHaveValue("A");
    const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
    await expect(monitor.getByRole("button", { name: "A", exact: true })).toBeVisible();
    await expect(monitor.getByRole("button", { name: "B", exact: true })).toBeVisible();
    const tasks = page.getByRole("table", { name: "Task telemetry", exact: true });
    await expect(tasks.getByRole("rowheader", { name: "Fast", exact: true })).toBeVisible();
    if (multiple) {
      await expect(tasks.getByRole("rowheader", { name: "Slow", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "RUN", exact: true }).click();
      for (const name of ["Fast", "Slow"]) {
        const count = tasks
          .getByRole("row")
          .filter({ has: page.getByRole("rowheader", { name, exact: true }) })
          .getByLabel("Runs", { exact: true });
        await expect.poll(async () => Number(await count.textContent())).toBeGreaterThan(0);
        const before = Number(await count.textContent());
        await expect.poll(async () => Number(await count.textContent())).toBeGreaterThan(before);
      }
      await page
        .getByRole("region", { name: "Runtime controls", exact: true })
        .getByRole("button", { name: "STOP", exact: true })
        .click();
      await page.setViewportSize({ width: 400, height: 800 });
      await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
      const localizedTasks = page.getByRole("table", { name: "タスクの実行状況", exact: true });
      await expect(
        localizedTasks.getByRole("columnheader", { name: "実行回数", exact: true }),
      ).toBeVisible();
      await expect(
        localizedTasks.getByRole("columnheader", { name: "前回 (ms)", exact: true }),
      ).toBeVisible();
      await expect(
        localizedTasks.getByRole("columnheader", { name: "最大 (ms)", exact: true }),
      ).toBeAttached();
      await expect(
        localizedTasks.getByRole("columnheader", { name: "超過回数", exact: true }),
      ).toBeAttached();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.getByRole("combobox", { name: "言語", exact: true }).selectOption("en");
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
    await expect(diagnostics).toContainText("Output writers overlap");
    await expect(page.getByLabel("Cycle (ms)")).toHaveCount(0);
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save project", exact: true }).click();
    const download = await downloadPromise;
    expect(
      readProject(readFileSync((await download.path())!, "utf8")).value?.configurationSource,
    ).toBe(configurationSource);
    const restore = page.getByRole("button", { name: "Open example", exact: true });
    await restore.click();
    await restore.click();
    await expect(page.getByRole("combobox", { name: "Instance", exact: true })).toHaveValue(
      "mainInstance",
    );
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

test("monitors connected PROGRAM parameters, rejects input writes and preserves connections", async ({
  page,
}) => {
  const { readFileSync } = await import("node:fs");
  const { readProject, writeProject } = await import("@benchtop-plc/project");
  const project = readProject(
    readFileSync(new URL("../../../examples/blink/project.xml", import.meta.url), "utf8"),
  ).value!;
  project.pous = [
    "PROGRAM Main VAR_INPUT requested : INT; END_VAR VAR_OUTPUT result : INT; END_VAR result := requested; END_PROGRAM",
  ];
  project.configurationSource = `CONFIGURATION Plant VAR_GLOBAL g : INT; END_VAR RESOURCE Station ON Cpu
TASK T (INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM A WITH T : Main (requested := 1, result => g);
END_RESOURCE END_CONFIGURATION`;
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "parameters.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(writeProject(project).value!),
  });
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    "No diagnostics",
  );
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const input = monitor.getByRole("row").filter({ has: page.locator('th[title="A.requested"]') });
  const output = monitor.getByRole("row").filter({ has: page.locator('th[title="A.result"]') });
  await input.getByRole("textbox", { name: "Value to write" }).fill("42");
  await input.getByRole("button", { name: "Write", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("connected input A.requested");
  await input.getByRole("button", { name: "Force", exact: true }).click();
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(input).toHaveAttribute("data-forced", "true");
  await expect(output.locator("td").nth(2)).toHaveText("42");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const saved = readProject(readFileSync((await (await downloadPromise).path())!, "utf8"));
  expect(saved.diagnostics).toEqual([]);
  expect(saved.value!.pous).toEqual(project.pous);
  expect(saved.value!.configurationSource).toBe(project.configurationSource);
});

test("navigates a parameter-copy fault to its configuration connection", async ({ page }) => {
  const { readFileSync } = await import("node:fs");
  const { readProject, writeProject } = await import("@benchtop-plc/project");
  const project = readProject(
    readFileSync(new URL("../../../examples/blink/project.xml", import.meta.url), "utf8"),
  ).value!;
  project.pous = ["PROGRAM Main VAR_INPUT requested : INT(0..10); END_VAR END_PROGRAM"];
  project.configurationSource = `CONFIGURATION Plant
VAR_GLOBAL g : INT := 11; END_VAR
RESOURCE Station ON Cpu TASK T (INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM A WITH T : Main (requested := g);
END_RESOURCE END_CONFIGURATION`;
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "fault.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(writeProject(project).value!),
  });
  await page
    .getByRole("region", { name: "POUs", exact: true })
    .getByRole("button", { name: /^Main PROGRAM/ })
    .click();
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("FAULT");
  await expect(page.locator(".runtime-fault-line")).toHaveCount(0);
  await page
    .getByRole("region", { name: "Diagnostics", exact: true })
    .getByRole("button")
    .filter({ hasText: "outside subrange" })
    .click();
  await expect(page.getByRole("textbox", { name: "Structured Text", exact: true })).toContainText(
    "CONFIGURATION Plant",
  );
  await expect(page.locator(".runtime-fault-line")).toContainText(
    "PROGRAM A WITH T : Main (requested := g)",
  );
});

test("keeps event program inline values visible while cyclic snapshots continue", async ({
  page,
}) => {
  const { readFileSync } = await import("node:fs");
  const { readProject, writeProject } = await import("@benchtop-plc/project");
  const project = readProject(
    readFileSync(new URL("../../../examples/blink/project.xml", import.meta.url), "utf8"),
  ).value!;
  project.pous = [
    "PROGRAM Main\nVAR count : DINT; END_VAR\ncount := count + 1;\nEND_PROGRAM",
    "PROGRAM FastProgram VAR count : DINT; END_VAR count := count + 1; END_PROGRAM",
  ];
  project.configurationSource = `CONFIGURATION Plant
VAR_GLOBAL trigger : BOOL := TRUE; END_VAR
RESOURCE Station ON Cpu
TASK Fast (INTERVAL := T#10ms, PRIORITY := 1);
TASK Edge (SINGLE := trigger, PRIORITY := 0);
PROGRAM OnEdge WITH Edge : Main;
PROGRAM CyclicInstance WITH Fast : FastProgram;
END_RESOURCE END_CONFIGURATION`;
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "event-annotations.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(writeProject(project).value!),
  });
  await page
    .getByRole("region", { name: "POUs", exact: true })
    .getByRole("button", { name: /^Main PROGRAM/ })
    .click();
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  const tasks = page.getByRole("table", { name: "Task telemetry", exact: true });
  const fastRuns = tasks
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "Fast", exact: true }) })
    .getByLabel("Runs", { exact: true });
  await expect.poll(async () => Number(await fastRuns.textContent())).toBeGreaterThanOrEqual(3);
  await page
    .getByRole("region", { name: "Runtime controls", exact: true })
    .getByRole("button", { name: "STOP", exact: true })
    .click();
  await expect(
    tasks
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name: "Edge", exact: true }) })
      .getByLabel("Runs", { exact: true }),
  ).toHaveText("1");
  await expect(page.locator(".inline-values .inline-number")).toHaveText("1");
  await expect(page.locator(".inline-values .inline-stale")).toHaveText("from scan 1");
  await page.getByRole("button", { name: "Cold reset", exact: true }).click();
  await expect(page.locator(".inline-values")).toHaveCount(0);
});

import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject, writeProject } from "@benchtop-plc/project";

const main = "PROGRAM Main\nVAR count : DINT; END_VAR\ncount := count + 1;\nEND_PROGRAM";
const configuration = `CONFIGURATION Plant
  RESOURCE Station ON BENCHTOP
    TASK Tick (INTERVAL := T#100ms, PRIORITY := 1);
    PROGRAM Second WITH Tick : Main;
    PROGRAM First WITH Tick : Main;
  END_RESOURCE
END_CONFIGURATION`;

test("adds two live instances, collapses groups, identifies inline values and round trips sources", async ({
  page,
}) => {
  await page.goto("/");
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await editor.fill(main);
  await page.getByRole("combobox", { name: "Cycle (ms)", exact: true }).selectOption("50");
  await list.getByRole("button", { name: "Add configuration", exact: true }).click();
  await expect(editor).toContainText("TASK Cyclic (INTERVAL := T#50ms, PRIORITY := 1)");
  await expect(editor).toContainText("PROGRAM mainInstance WITH Cyclic : Main");
  await expect(list.getByRole("button", { name: "Add configuration", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Cycle (ms)", exact: true })).toHaveCount(0);
  await editor.fill(configuration);
  await expect(list.getByRole("button", { name: /^Plant CONFIGURATION/ })).toContainText(
    "Diagnostics: 0",
  );
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const groups = monitor.getByRole("button", { name: /^(Second|First)$/, exact: true });
  await expect(groups).toHaveText(["Second", "First"]);
  const counts = monitor.locator('th[title$=".count"]').locator("..").locator("td").nth(2);
  const rows = monitor
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "count", exact: true }) });
  await expect(rows).toHaveCount(2);
  for (const index of [0, 1]) {
    await expect
      .poll(async () => Number(await rows.nth(index).locator("td").nth(2).textContent()))
      .toBeGreaterThan(0);
  }
  const before = Number(await counts.textContent());
  await expect.poll(async () => Number(await counts.textContent())).toBeGreaterThan(before);
  await monitor.getByRole("button", { name: "Second", exact: true }).click();
  await expect(monitor.getByRole("button", { name: "Second", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(rows).toHaveCount(1);
  await monitor.getByRole("button", { name: "Second", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await list.getByRole("button", { name: /^Main PROGRAM/ }).click();
  await expect(page.getByRole("combobox", { name: "Instance", exact: true })).toHaveValue("Second");
  await expect(page.locator(".inline-values")).toHaveCount(1);
  await page
    .getByRole("region", { name: "Runtime controls", exact: true })
    .getByRole("button", { name: "STOP", exact: true })
    .click();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  // Distinct instance state proves that the annotation comes from declaration order.
  await rows.nth(0).getByRole("textbox", { name: "Value to write", exact: true }).fill("1000");
  await rows.nth(0).getByRole("button", { name: "Write", exact: true }).click();
  await rows.nth(1).getByRole("textbox", { name: "Value to write", exact: true }).fill("2000");
  await rows.nth(1).getByRole("button", { name: "Write", exact: true }).click();
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(rows.nth(0).locator("td").nth(2)).toHaveText("1001");
  await expect(rows.nth(1).locator("td").nth(2)).toHaveText("2001");
  await expect(page.locator(".inline-values")).toHaveText("1001");
  await list.getByRole("button", { name: /^Plant CONFIGURATION/ }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const xml = readFileSync((await (await download).path())!, "utf8");
  expect(readProject(xml).value).toMatchObject({
    configurationSource: configuration,
    pous: [main],
  });
  await page.reload();
  await expect(editor.locator(".cm-line")).toHaveText(configuration.split("\n"));
  await expect(list.getByRole("button", { name: /^Plant CONFIGURATION/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  await expect(groups).toHaveText(["Second", "First"]);
  await expect(rows.nth(0).locator("td").nth(2)).toHaveText("0");
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "configured.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await list.getByRole("button", { name: /^Plant CONFIGURATION/ }).click();
  await expect(editor.locator(".cm-line")).toHaveText(configuration.split("\n"));
});

test("navigates configuration diagnostics, autosaves a damaged header and confirms deletion", async ({
  page,
}) => {
  await page.goto("/");
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  const diagnostics = page.getByRole("region", { name: "Diagnostics", exact: true });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: "Add configuration", exact: true }).click();
  await editor.fill(configuration.replaceAll(": Main", ": Missing"));
  await expect(list.getByRole("button", { name: /^Plant CONFIGURATION/ })).toContainText(
    "Diagnostics: 2",
  );
  await list.getByRole("button", { name: /^Main PROGRAM/ }).click();
  await expect(page.locator(".cm-lintRange-error")).toHaveCount(0);
  await diagnostics.getByRole("button").filter({ hasText: "Missing" }).first().click();
  await expect(editor).toContainText("CONFIGURATION Plant");
  await expect(page.locator(".cm-lintRange-error")).not.toHaveCount(0);
  await editor.fill("CONFIGURATION");
  await expect(list.getByRole("button", { name: /^Plant CONFIGURATION/ })).toContainText(
    "Diagnostics: 1",
  );
  await page.reload();
  await expect(editor).toHaveText("CONFIGURATION");
  await expect(list.getByRole("button", { name: /^Plant CONFIGURATION/ })).toBeVisible();
  await list.getByRole("button", { name: "Delete Plant", exact: true }).click();
  await list.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(list.getByRole("button", { name: /^Plant CONFIGURATION/ })).toBeVisible();
  await list.getByRole("button", { name: "Delete Plant", exact: true }).click();
  await list.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(editor).toContainText("PROGRAM Main");
  await expect(page.getByRole("combobox", { name: "Cycle (ms)", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  await expect(page.getByRole("button", { name: "mainInstance", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(
    page.getByRole("button", { name: "コンフィグレーションを追加", exact: true }),
  ).toBeVisible();
});

test("shows no inline values for an uninstantiated PROGRAM", async ({ page }) => {
  const base = readProject(readFileSync("examples/blink/project.xml", "utf8")).value!;
  const unused = "PROGRAM Unused\nVAR count : DINT; END_VAR\ncount := 99;\nEND_PROGRAM";
  const xml = writeProject({
    ...base,
    pous: [unused, main],
    configurationSource: configuration,
  }).value!;
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page
    .getByLabel("Open project", { exact: true })
    .setInputFiles({ name: "unused.xml", mimeType: "application/xml", buffer: Buffer.from(xml) });
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  await expect(page.getByRole("textbox", { name: "Structured Text", exact: true })).toContainText(
    "PROGRAM Unused",
  );
  await expect(page.locator(".inline-values")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Instance", exact: true })).toHaveCount(0);
  await expect(page.getByText("No instance to show", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Main PROGRAM/ }).click();
  await expect(page.getByRole("combobox", { name: "Instance", exact: true })).toHaveValue("Second");
  await expect(page.locator(".inline-values")).toHaveCount(1);
});

test("shows current variable types in two configured programs and their globals", async ({
  page,
}) => {
  const base = readProject(readFileSync("examples/blink/project.xml", "utf8")).value!;
  const first = `PROGRAM Main
VAR count : DINT; END_VAR
VAR_EXTERNAL timer : TON; END_VAR
count := count + 1;
timer(IN := TRUE);
END_PROGRAM`;
  const second = `PROGRAM Other
VAR count : BOOL; END_VAR
VAR_EXTERNAL timer : TON; END_VAR
count := TRUE;
timer(PT := LT#1s);
END_PROGRAM`;
  const config = `CONFIGURATION Plant
VAR_GLOBAL timer : TON; END_VAR
RESOURCE Station ON BENCHTOP
TASK Tick (INTERVAL := T#100ms, PRIORITY := 1);
PROGRAM First WITH Tick : Main;
PROGRAM Second WITH Tick : Other;
END_RESOURCE
END_CONFIGURATION`;
  const xml = writeProject({
    ...base,
    pous: [first, second],
    configurationSource: config,
  }).value!;
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "hover.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  const hover = async (linePattern: RegExp, name: string, expected: string) => {
    await page.mouse.move(0, 0);
    const line = editor.locator(".cm-line").filter({ hasText: linePattern });
    await line.scrollIntoViewIfNeeded();
    const point = await line.evaluate((element, name) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let text = walker.nextNode();
      while (text && !text.textContent!.includes(name)) text = walker.nextNode();
      if (!text) throw new Error("Expected variable text");
      const offset = text.textContent!.indexOf(name);
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, offset + name.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, name);
    await page.mouse.move(point.x, point.y);
    await expect(page.locator(".cm-tooltip-hover")).toHaveText(expected);
  };
  for (const [name, type] of [
    ["Main", "DINT"],
    ["Other", "BOOL"],
  ]) {
    await list.getByRole("button", { name: new RegExp(`^${name} PROGRAM`) }).click();
    await hover(/^count :=/, "count", `count: ${type}`);
    await hover(/^timer\(/, "timer", "timer: TON_LTIME");
  }
  // Close the hover before fill focuses the editor and scrolls the page.
  await page.mouse.move(0, 0);
  await expect(page.locator(".cm-tooltip-hover")).toHaveCount(0);
  // The loaded runtime still has LTIME; hovers must use the unapplied editor compilation.
  await editor.fill(second.replace("LT#1s", "T#1s"));
  await hover(/^timer\(/, "timer", "timer: TON");
  await list.getByRole("button", { name: /^Plant CONFIGURATION/ }).click();
  await hover(/^VAR_GLOBAL timer/, "timer", "timer: TON");
});

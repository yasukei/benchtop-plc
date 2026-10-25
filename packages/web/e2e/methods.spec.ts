import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject, writeProject, SOURCE_NAMESPACE } from "@benchtop-plc/project";

const original = "PROGRAM Main\nVAR Legacy: INT; END_VAR\nLegacy := 42;\nEND_PROGRAM";
function projectFile(pous: string[]) {
  const base = readProject(readFileSync("examples/blink/project.xml", "utf8")).value!;
  return writeProject({ ...base, pous, panel: [] }).value!;
}

test("runs methods, shows inline results and round trips the exact block text", async ({
  page,
}) => {
  const main =
    "PROGRAM Main\nVAR c: Counter; seen: INT; END_VAR\nc.Increment();\nc.Value();\nseen := c.Value();\nEND_PROGRAM";
  const block = `FUNCTION_BLOCK Counter
VAR PRIVATE n: INT; END_VAR
METHOD PUBLIC Increment VAR work: INT := 42; END_VAR n := work; END_METHOD
METHOD PUBLIC Value : INT Value := n; END_METHOD
END_FUNCTION_BLOCK`;
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "methods.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(projectFile([main, block])),
  });
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  await expect(page.locator(".inline-values")).toContainText(["42", "42"]);
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const member = monitor
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: /^C\.N/ }) });
  await expect(member).toBeVisible();
  await expect(monitor.getByRole("rowheader", { name: /work/i })).toHaveCount(0);
  await member.getByRole("textbox", { name: "Value to write", exact: true }).fill("7");
  await member.getByRole("button", { name: "Force", exact: true }).click();
  await expect(member).toHaveAttribute("data-forced", "true");
  await expect(member.locator("td").nth(2)).toHaveText("7");
  await page
    .getByRole("region", { name: "Runtime controls", exact: true })
    .getByRole("button", { name: "STOP", exact: true })
    .click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const xml = readFileSync((await (await download).path())!, "utf8");
  expect(readProject(xml).value?.pous).toEqual([main, block]);
});

for (const extension of [true, false]) {
  test(`opens a reserved-name draft and blocks run/save until renamed (extension: ${extension})`, async ({
    page,
  }) => {
    let xml = projectFile([original]).replaceAll("Legacy", "Public");
    if (!extension)
      xml = xml.replace(
        new RegExp(`<data name="${SOURCE_NAMESPACE}"[^>]*>[\\s\\S]*?</data>`, "g"),
        "",
      );
    await page.goto("/");
    await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
    await page
      .getByLabel("Open project", { exact: true })
      .setInputFiles({ name: "legacy.xml", mimeType: "application/xml", buffer: Buffer.from(xml) });
    const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
    await expect(editor).toContainText("Public");
    await expect(page.locator(".cm-lintRange-error")).not.toHaveCount(0);
    await page.getByRole("button", { name: "RUN", exact: true }).click();
    await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
    const downloads: unknown[] = [];
    page.on("download", (download) => downloads.push(download));
    await page.getByRole("button", { name: "Save project", exact: true }).click();
    await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).not.toBeEmpty();
    expect(downloads).toHaveLength(0);
    await page.reload();
    await expect(editor).toContainText("Public");
    await editor.fill(original.replaceAll("Legacy", "count"));
    await page.getByRole("button", { name: "RUN", exact: true }).click();
    await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save project", exact: true }).click();
    expect(readProject(readFileSync((await (await download).path())!, "utf8")).value?.pous).toEqual(
      [original.replaceAll("Legacy", "count")],
    );
  });
}

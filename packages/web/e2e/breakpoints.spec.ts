import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("halts the sorting conveyor before counting a part and publishes its output only after Continue", async ({
  page,
}) => {
  const xml = readFileSync(
    new URL("../../../examples/sorting-conveyor/project.xml", import.meta.url),
    "utf8",
  );
  await page.goto("/");
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "sorting-conveyor.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const panel = page.getByRole("region", { name: "Operator panel", exact: true });
  const total = panel.getByLabel("BIN A TOTAL", { exact: true }).locator("strong");
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await panel.getByRole("button", { name: "START", exact: true }).focus();
  await page.keyboard.down("Space");
  await expect(panel.getByRole("status", { name: "BELT RUN", exact: true })).toHaveAttribute(
    "data-on",
    "true",
  );
  await page.keyboard.up("Space");
  await page.getByRole("button", { name: /^PartCounter FUNCTION_BLOCK/ }).click();
  await expect(page.getByRole("combobox", { name: "Instance", exact: true })).toHaveValue(
    "mainInstance.BINA",
  );
  await page.locator('.breakpoint-marker[data-line="9"]').click();
  await expect(page.locator('.breakpoint-marker[data-line="9"]')).toHaveAttribute(
    "data-breakpoint",
    "active",
  );
  await panel.getByRole("button", { name: "PART A", exact: true }).focus();
  await page.keyboard.down("Space");
  try {
    await expect(page.locator(".halt-banner")).toContainText(
      "PartCounter.Count, line 9 (mainInstance.BINA), task Cyclic",
    );
    await expect(page.getByLabel("Runtime state", { exact: true })).toHaveText("HALT");
    await expect(page.locator(".runtime-halt-statement")).toHaveText("Parts := Parts + 1;");
    await expect(page.getByRole("combobox", { name: "Instance", exact: true })).toHaveValue(
      "mainInstance.BINA",
    );
    const parts = page
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name: "BINA.PARTS", exact: true }) });
    await expect(parts).toContainText("0");
    await expect(total).toHaveText("0");
    await expect(panel.getByRole("status", { name: "BELT RUN", exact: true })).toHaveAttribute(
      "data-on",
      "true",
    );

    await expect(panel.getByRole("status", { name: "DIVERT A", exact: true })).toHaveAttribute(
      "data-on",
      "false",
    );
    await expect(page.getByRole("button", { name: "Single scan", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "RUN", exact: true })).toBeDisabled();
  } finally {
    await page.keyboard.up("Space");
  }
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(total).toHaveText("1");
  await expect(page.locator(".halt-banner")).toHaveCount(0);
  await expect(panel.getByRole("status", { name: "DIVERT A", exact: true })).toHaveAttribute(
    "data-on",
    "false",
  );
  await panel.getByRole("button", { name: "PART A", exact: true }).focus();
  await page.keyboard.down("Space");
  try {
    await expect(page.locator(".halt-banner")).toBeVisible();
    await expect(panel.getByRole("status", { name: "BELT RUN", exact: true })).toHaveAttribute(
      "data-on",
      "true",
    );
    await expect(total).toHaveText("1");
    const image = page.getByRole("region", { name: "I/O image", exact: true });
    await expect(image.getByLabel("%QX0.0", { exact: true })).toHaveAttribute("data-on", "true");
    await expect(image.getByLabel("%QW1", { exact: true }).locator("strong")).toHaveText("1");
  } finally {
    await page.keyboard.up("Space");
  }
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(total).toHaveText("2");
  await expect(page.locator(".halt-banner")).toHaveCount(0);
  await expect(page.locator(".runtime-halt-statement")).toHaveCount(0);
  await page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true }).click();
});

test("maps gutter markers through edits, restores them from autosave and hides a halt location in changed text", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  const source = "PROGRAM Main\nVAR n: INT; END_VAR\nn := n + 1;\nEND_PROGRAM";
  await editor.fill(source);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await page.locator('.breakpoint-marker[data-line="3"]').click();
  await expect(page.locator(".halt-banner")).toBeVisible();
  await editor.press("Control+Home");
  await editor.press("Enter");
  await expect(page.locator('.breakpoint-marker[data-line="4"]')).toHaveAttribute(
    "data-breakpoint",
    "active",
  );
  await expect(page.locator(".runtime-halt-statement")).toHaveCount(0);
  await expect(page.locator(".inline-values")).toHaveCount(0);
  await expect(page.locator(".halt-banner")).toBeVisible();
  await expect(page.getByRole("button", { name: "RUN", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.locator(".halt-banner")).toContainText("line 4");
  await page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => JSON.parse(localStorage.getItem("benchtop-plc.work") ?? "{}").breakpoints?.MAIN,
      ),
    )
    .toEqual([4]);
  await page.reload();
  await expect(page.locator('.breakpoint-marker[data-line="4"]')).toHaveAttribute(
    "data-breakpoint",
    "active",
  );
});

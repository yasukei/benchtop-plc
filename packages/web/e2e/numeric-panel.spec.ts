import { expect, test } from "@playwright/test";

test("edits, saves and operates numeric word parts with a bounded slider", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(`PROGRAM Analog
VAR setpoint AT %IW0 : INT; actual AT %QW0 : INT; END_VAR
actual := setpoint;
END_PROGRAM`);
  const panel = page
    .locator("section.panel")
    .filter({ has: page.getByRole("heading", { name: "Operator panel", exact: true }) });
  await panel.getByRole("button", { name: "Edit panel", exact: true }).click();
  await panel
    .getByRole("combobox", { name: "Part type", exact: true })
    .selectOption("numericInput");
  await panel.getByRole("button", { name: "Add part", exact: true }).click();
  await panel.getByLabel("Label", { exact: true }).fill("Setpoint");
  await expect(panel.getByRole("combobox", { name: "Address", exact: true })).toHaveValue("%IW0");
  await expect(panel.getByRole("combobox", { name: "Type", exact: true })).toHaveValue("INT");
  await panel.getByLabel("Minimum", { exact: true }).fill("-100");
  await panel.getByLabel("Maximum", { exact: true }).fill("100");
  await panel.getByRole("button", { name: "Apply range", exact: true }).click();
  await panel
    .getByRole("combobox", { name: "Part type", exact: true })
    .selectOption("numericDisplay");
  await panel.getByRole("button", { name: "Add part", exact: true }).click();
  await panel.getByLabel("Label", { exact: true }).fill("Actual");
  await expect(panel.getByRole("combobox", { name: "Address", exact: true })).toHaveValue("%QW0");
  await panel
    .getByRole("combobox", { name: "Part type", exact: true })
    .selectOption("numericInput");
  await panel.getByRole("button", { name: "Add part", exact: true }).click();
  await panel.getByLabel("Label", { exact: true }).fill("Mirror input");
  const downloadPromise = page.waitForEvent("download");
  await panel.getByRole("button", { name: "Save project", exact: true }).click();
  const saved = await (await downloadPromise).path();
  await panel.getByLabel("Open project", { exact: true }).setInputFiles(saved!);
  await panel.getByRole("button", { name: "Operate", exact: true }).click();
  const input = panel.getByRole("spinbutton", { name: "Setpoint", exact: true });
  const display = panel.getByLabel("Actual", { exact: true });
  await input.fill("-25");
  await expect(display).toHaveText("Actual0");
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(display).toHaveText("Actual-25");
  await input.fill("32768");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(panel.getByRole("alert")).toContainText("valid value");
  await expect(display).toHaveText("Actual-25");
  await input.fill("101");
  await expect(input).toHaveAttribute("aria-invalid", "true");
  const slider = panel.getByRole("slider", { name: "Setpoint Slider", exact: true });
  await slider.focus();
  await slider.fill("75");
  await expect(display).toHaveText("Actual75");
  await expect(input).toHaveValue("75");
  const mirror = panel.getByRole("spinbutton", { name: "Mirror input", exact: true });
  await mirror.fill("25");
  await expect(display).toHaveText("Actual25");
  await expect(input).toHaveValue("25");
  await expect(slider).toHaveValue("25");
  await mirror.fill("75");
  await page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true }).click();
  await expect(display).toHaveText("Actual0");
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(display).toHaveText("Actual75");
  await panel.getByRole("button", { name: "Emergency stop", exact: true }).click();
  await expect(display).toHaveText("Actual0");
});

test("preserves exact long input digits and shows invalid real outputs safely", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(`PROGRAM LongAnalog
VAR n AT %IL0 : ULINT; out AT %QL0 : ULINT; bits AT %QD2 : DWORD; END_VAR
out := n;
bits := 16#7FC00000;
END_PROGRAM`);
  const panel = page
    .locator("section.panel")
    .filter({ has: page.getByRole("heading", { name: "Operator panel", exact: true }) });
  await panel.getByRole("button", { name: "Edit panel", exact: true }).click();
  for (const [kind, type, label, address] of [
    ["numericInput", "ULINT", "Long input", "%IL0"],
    ["numericDisplay", "ULINT", "Long output", "%QL0"],
    ["numericDisplay", "REAL", "Sample", "%QD2"],
  ]) {
    await panel.getByRole("combobox", { name: "Part type", exact: true }).selectOption(kind!);
    await panel.getByRole("button", { name: "Add part", exact: true }).click();
    await panel.getByLabel("Label", { exact: true }).fill(label!);
    await panel.getByRole("combobox", { name: "Type", exact: true }).selectOption(type!);
    await panel.getByRole("combobox", { name: "Address", exact: true }).selectOption(address!);
  }
  await panel.getByRole("button", { name: "Operate", exact: true }).click();
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await panel
    .getByRole("spinbutton", { name: "Long input", exact: true })
    .fill("18446744073709551615");
  await expect(panel.getByLabel("Long output", { exact: true })).toContainText(
    "18446744073709551615",
  );
  await expect(panel.getByLabel("Sample", { exact: true })).toContainText("Invalid (16#7FC00000)");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(page.getByLabel("Sample", { exact: true })).toContainText("無効 (16#7FC00000)");
});

test("disables numeric inputs when the runtime connection closes", async ({ page }) => {
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        window.addEventListener("disconnect-test-worker", () => {
          this.terminate();
          this.dispatchEvent(new Event("error"));
        });
      }
    };
  });
  await page.goto("/");
  const panel = page
    .locator("section.panel")
    .filter({ has: page.getByRole("heading", { name: "Operator panel", exact: true }) });
  await panel.getByRole("button", { name: "Edit panel", exact: true }).click();
  await panel
    .getByRole("combobox", { name: "Part type", exact: true })
    .selectOption("numericInput");
  await panel.getByRole("button", { name: "Add part", exact: true }).click();
  await panel.getByLabel("Minimum", { exact: true }).fill("0");
  await panel.getByLabel("Maximum", { exact: true }).fill("100");
  await panel.getByRole("button", { name: "Apply range", exact: true }).click();
  await panel.getByRole("button", { name: "Operate", exact: true }).click();
  await expect(panel.getByRole("spinbutton")).toBeEnabled();
  await page.evaluate(() => window.dispatchEvent(new Event("disconnect-test-worker")));
  await expect(panel.getByRole("spinbutton")).toBeDisabled();
  await expect(panel.getByRole("slider")).toBeDisabled();
});

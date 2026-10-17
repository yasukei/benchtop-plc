import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { savePanelProject } from "../src/panel/project.js";
import type { PanelLayout } from "../src/panel/layout.js";

const reference = readFileSync(
  new URL("../../../tests/conformance/reference/program.st", import.meta.url),
  "utf8",
);
const layout: PanelLayout = [
  { id: "1", kind: "pushbutton", label: "START", bit: 0, color: "green", x: 0, y: 0 },
  { id: "2", kind: "pushbutton", label: "STOP PB", bit: 1, color: "green", x: 0.5, y: 0 },
  { id: "3", kind: "selector", label: "RESET", bit: 2, color: "green", x: 1, y: 0 },
  { id: "4", kind: "led", label: "Running", bit: 0, color: "green", x: 0, y: 0.5 },
  { id: "5", kind: "led", label: "Lamp", bit: 1, color: "amber", x: 0.5, y: 0.5 },
  { id: "6", kind: "led", label: "Alarm LED", bit: 2, color: "red", x: 1, y: 0.5 },
  { id: "7", kind: "estop", label: "Emergency stop", bit: null, color: "red", x: 0.5, y: 1 },
];
async function openReference(page: Page) {
  await page.goto("/");
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "reference.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(savePanelProject(reference, layout, 10, null)!),
  });
  await expect(page.getByRole("button", { name: "START", exact: true })).toBeVisible();
}
async function hold(page: Page, name: string, assertion: () => Promise<void>) {
  const button = page.getByRole("button", { name, exact: true });
  await button.scrollIntoViewIfNeeded();
  await button.hover();
  await page.mouse.down();
  try {
    await assertion();
  } finally {
    await page.mouse.up();
  }
}

test("operates the reference PLC, debug values and emergency stop through the real Worker", async ({
  page,
}) => {
  await openReference(page);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  const running = page.getByLabel("Running", { exact: true });
  const lamp = page.getByLabel("Lamp", { exact: true });
  await hold(page, "START", async () => {
    await expect(running).toHaveAttribute("data-on", "true");
  });
  await expect(page.getByLabel("%IX0.0", { exact: true })).toContainText("OFF");
  await expect(lamp).toHaveAttribute("data-on", "true");
  await expect(lamp).toHaveAttribute("data-on", "false");
  await hold(page, "STOP PB", async () => {
    await expect(running).toHaveAttribute("data-on", "false");
    await expect(lamp).toHaveAttribute("data-on", "false");
  });
  // Both keyboard activation keys are momentary and release on keyup.
  const start = page.getByRole("button", { name: "START", exact: true });
  for (const key of ["Space", "Enter"]) {
    await start.focus();
    await page.keyboard.down(key);
    await expect(page.getByLabel("%IX0.0", { exact: true })).toContainText("ON");
    await expect(running).toHaveAttribute("data-on", "true");
    await page.keyboard.up(key);
    await expect(page.getByLabel("%IX0.0", { exact: true })).toContainText("OFF");
  }
  await page.getByRole("button", { name: "Emergency stop", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Emergency stop is active");
  await expect(page.getByRole("button", { name: "RUN", exact: true })).toBeDisabled();
  await expect(page.locator(".led-part[data-on='true']")).toHaveCount(0);
  await page.getByRole("button", { name: "Emergency stop", exact: true }).press("Enter");
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  await expect(page.locator(".banner")).toContainText("Press RUN to restart");
  await expect(page.locator(".led-part[data-on='true']")).toHaveCount(0);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  const alarm = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: /^Alarm(?: Forced)?$/ }) });
  await alarm.getByRole("button", { name: "Force TRUE", exact: true }).click();
  await expect(alarm).toHaveAttribute("data-forced", "true");
  await expect(page.getByLabel("Alarm LED", { exact: true })).toHaveAttribute("data-on", "true");
  await alarm.getByRole("button", { name: "Force FALSE", exact: true }).click();
  await expect(page.getByLabel("Alarm LED", { exact: true })).toHaveAttribute("data-on", "false");
  await alarm.getByRole("button", { name: "Unforce", exact: true }).click();
  await expect(alarm).toHaveAttribute("data-forced", "false");
  const time = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "BlinkTime", exact: true }) });
  for (const value of ["T#250ms", "750"]) {
    await time.getByLabel("Value to write").fill(value);
    await time.getByRole("button", { name: "Write", exact: true }).click();
    await expect(time).toContainText(value === "750" ? "T#750ms" : value);
  }
  await time.getByLabel("Value to write").fill("invalid");
  await time.getByRole("button", { name: "Write", exact: true }).click();
  await expect(time.getByRole("alert")).toContainText("valid value");
  await expect(
    page
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name: "tBlinkOn", exact: true }) }),
  ).toContainText(/Q=(TRUE|FALSE), ET=T#/);
  const selector = page.getByRole("switch", { name: "RESET", exact: true });
  await selector.press("Space");
  await expect(selector).toBeChecked();
  await selector.press("Enter");
  await expect(selector).not.toBeChecked();
});

test("releases held inputs on blur, pointer cancellation and entering edit mode", async ({
  page,
}) => {
  await openReference(page);
  const start = page.getByRole("button", { name: "START", exact: true });
  const input = page.getByLabel("%IX0.0", { exact: true });
  await start.focus();
  await page.keyboard.down("Space");
  await expect(input).toContainText("ON");
  await page.getByRole("button", { name: "RUN", exact: true }).focus();
  await expect(input).toContainText("OFF");
  await page.keyboard.up("Space");
  await start.hover();
  await page.mouse.down();
  await expect(input).toContainText("ON");
  await start.dispatchEvent("pointercancel", { pointerId: 1 });
  await expect(input).toContainText("OFF");
  await page.mouse.up();
  await start.focus();
  await page.keyboard.down("Enter");
  await expect(input).toContainText("ON");
  await page.getByRole("button", { name: "Edit panel", exact: true }).click();
  await expect(input).toContainText("OFF");
  await page.keyboard.up("Enter");
});

test("edits and drags fractional panel layouts and persists through the project package", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Edit panel", exact: true }).click();
  await page.getByRole("combobox", { name: "Part type", exact: true }).selectOption("led");
  await page.getByRole("button", { name: "Add part", exact: true }).click();
  await page.getByLabel("Label", { exact: true }).fill("Custom LED");
  await page.getByRole("combobox", { name: "Address", exact: true }).selectOption("%QX0.7");
  await page.getByRole("combobox", { name: "Color", exact: true }).selectOption("blue");
  const part = page.getByRole("button", { name: "Custom LED", exact: true });
  const initial = await part.boundingBox();
  await part.hover();
  await page.mouse.down();
  await page.mouse.move(
    initial!.x + initial!.width / 2 + 25,
    initial!.y + initial!.height / 2 + 30,
  );
  await page.mouse.up();
  expect((await part.boundingBox())!.y).toBeGreaterThan(initial!.y + 20);
  await part.press("ArrowRight");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const download = await downloadPromise;
  const saved = await download.path();
  expect(saved).toBeTruthy();
  await page.getByRole("button", { name: "Delete part", exact: true }).click();
  await expect(part).toHaveCount(0);
  await page.getByLabel("Open project", { exact: true }).setInputFiles(saved!);
  await expect(part).toBeVisible();
  await part.click();
  await expect(page.getByRole("combobox", { name: "Address", exact: true })).toHaveValue("%QX0.7");
  await expect(page.getByRole("combobox", { name: "Color", exact: true })).toHaveValue("blue");
  await page.getByRole("combobox", { name: "Part type", exact: true }).selectOption("estop");
  await page.getByRole("button", { name: "Add part", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add part", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Address", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Operate", exact: true }).click();
  await expect(page.getByLabel("Custom LED", { exact: true })).toHaveAttribute(
    "data-color",
    "blue",
  );
  // CI uses wider system-font metrics than the local Chromium default.
  await page.addStyleTag({ content: ' :root { font-family: "DejaVu Sans", sans-serif; }' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

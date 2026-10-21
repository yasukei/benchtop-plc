import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("opens the running light project and operates its LEDs in both directions", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/");
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "running-light.xml",
    mimeType: "application/xml",
    buffer: readFileSync(new URL("../../../examples/running-light/project.xml", import.meta.url)),
  });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    "No diagnostics",
  );
  await expect(page.locator(".positioned-part")).toHaveCount(11);
  const panel = page.getByRole("region", { name: "Operator panel", exact: true });
  const direction = panel.getByRole("switch", { name: "DIRECTION", exact: true });
  await expect(direction).not.toBeChecked();
  const leds = panel.locator(".led-part");
  await expect(leds).toHaveCount(8);
  const boxes = await leds.locator(".led-light").all();
  for (let bit = 0; bit < 8; bit++) {
    const led = leds.nth(bit);
    await expect(led).toHaveAccessibleName(String(bit));
    await expect(led).toHaveAttribute("data-on", "false");
    if (bit > 0) {
      const previous = (await boxes[bit - 1]!.boundingBox())!;
      const current = (await boxes[bit]!.boundingBox())!;
      expect(current.y).toBe(previous.y);
      expect(current.x).toBeGreaterThanOrEqual(previous.x + previous.width);
    }
  }
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  // A longer interval keeps each LED observable across Worker snapshot updates.
  const speed = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "Speed", exact: true }) });
  await speed.getByLabel("Value to write").fill("T#1s");
  await speed.getByRole("button", { name: "Write", exact: true }).click();
  await expect(speed.locator("td").nth(2)).toHaveText("T#1s");
  const start = panel.getByRole("button", { name: "START", exact: true });
  const stop = panel.getByRole("button", { name: "STOP", exact: true });
  await start.focus();
  await page.keyboard.down("Space");
  await expect(leds.nth(0)).toHaveAttribute("data-on", "true");
  await page.keyboard.up("Space");
  await expect(leds.nth(1)).toHaveAttribute("data-on", "true");
  await stop.focus();
  await page.keyboard.down("Space");
  await expect(panel.locator('.led-part[data-on="true"]')).toHaveCount(0);
  await page.keyboard.up("Space");
  await direction.click();
  await expect(direction).toBeChecked();
  await start.focus();
  await page.keyboard.down("Space");
  await expect(leds.nth(1)).toHaveAttribute("data-on", "true");
  await page.keyboard.up("Space");
  await expect(leds.nth(0)).toHaveAttribute("data-on", "true");
  await expect(leds.nth(7)).toHaveAttribute("data-on", "true");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

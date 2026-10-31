import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject } from "@benchtop-plc/project";
import { retentiveStorageKey } from "../src/autosave.js";

test("operates both tanks and keeps run-time counters across reload and project text across save/reopen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const xml = readFileSync(
    new URL("../../../examples/tank-station/project.xml", import.meta.url),
    "utf8",
  );
  const original = readProject(xml).value!;
  await page.goto("/");
  const open = page.getByLabel("Open project", { exact: true });
  await open.setInputFiles({
    name: "tank-station.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    "No diagnostics",
  );
  const sources = page.getByRole("region", { name: "POUs", exact: true });
  for (const name of [
    "TankStation CONFIGURATION",
    "TankControl PROGRAM",
    "StationStatistics PROGRAM",
    "Acknowledge PROGRAM",
  ])
    await expect(sources.getByRole("button", { name: new RegExp(`^${name}`) })).toBeVisible();

  const panel = page.getByRole("region", { name: "Operator panel", exact: true });
  await expect(panel.locator(".positioned-part")).toHaveCount(13);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const boxes = await panel.locator(".positioned-part").evaluateAll((parts) =>
      parts.map((part) => {
        const { x, y, width, height } = part.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
    for (const [index, first] of boxes.entries())
      for (const second of boxes.slice(index + 1))
        expect(
          first.x + first.width <= second.x ||
            second.x + second.width <= first.x ||
            first.y + first.height <= second.y ||
            second.y + second.height <= first.y,
        ).toBe(true);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const level = (tank: number) =>
    panel.getByRole("spinbutton", { name: `LEVEL ${tank} (%)`, exact: true });
  const lamp = (name: string) => panel.getByRole("status", { name, exact: true });
  const display = (tank: number) => panel.getByLabel(`RUN ${tank} (0.1 s)`, { exact: true });
  const count = async (tank: number) => Number(await display(tank).locator("strong").innerText());
  const press = async (name: string, expectedLamp: string, on: boolean) => {
    await panel.getByRole("button", { name, exact: true }).focus();
    await page.keyboard.down("Space");
    try {
      await expect(lamp(expectedLamp)).toHaveAttribute("data-on", String(on));
    } finally {
      await page.keyboard.up("Space");
    }
  };
  await panel.getByRole("spinbutton", { name: "SETPOINT (%)", exact: true }).fill("50");
  await level(1).fill("20");
  await level(2).fill("20");
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  await expect(page.getByLabel("Scans", { exact: true })).not.toHaveText("0");
  await press("START 1", "PUMP 1", true);
  await press("START 2", "PUMP 2", true);
  await expect.poll(() => count(1)).toBeGreaterThan(0);
  await expect.poll(() => count(2)).toBeGreaterThan(0);
  await level(1).fill("50");
  await expect(lamp("PUMP 1")).toHaveAttribute("data-on", "false");
  await expect(lamp("PUMP 2")).toHaveAttribute("data-on", "true");
  await level(1).fill("90");
  await expect(lamp("ALARM 1")).toHaveAttribute("data-on", "true");
  await level(1).fill("20");
  await press("ACK", "ALARM 1", false);
  await expect(lamp("PUMP 1")).toHaveAttribute("data-on", "false");
  await press("STOP TANKS", "PUMP 2", false);
  const kept = [await count(1), await count(2)];
  await page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          JSON.parse(localStorage.getItem(key)!)
            .filter((record: { path: string }) => record.path.endsWith(".RunTicks"))
            .map((record: { value: { value: number } }) => record.value.value),
        retentiveStorageKey,
      ),
    )
    .toEqual(kept);
  await page.reload();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  // Output images are zero in STOP; RUN republishes the retained values without starting pumps.
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  for (const tank of [1, 2]) {
    await expect.poll(() => count(tank)).toBe(kept[tank - 1]);
    await expect(lamp(`PUMP ${tank}`)).toHaveAttribute("data-on", "false");
  }
  await page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const saved = await (await download).path();
  const reopened = readProject(readFileSync(saved!, "utf8"));
  expect(reopened.diagnostics).toEqual([]);
  expect(reopened.value!.configurationSource).toBe(original.configurationSource);
  expect(reopened.value!.pous).toEqual(original.pous);
  expect(reopened.value!.panel).toEqual(original.panel);
  await open.setInputFiles(saved!);
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  for (const tank of [1, 2]) await expect.poll(() => count(tank)).toBe(0);
});

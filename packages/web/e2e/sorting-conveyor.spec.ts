import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject } from "@benchtop-plc/project";

test("sorts parts, monitors retained totals and preserves all sources on save/reopen", async ({
  page,
}) => {
  const xml = readFileSync(
    new URL("../../../examples/sorting-conveyor/project.xml", import.meta.url),
    "utf8",
  );
  const original = readProject(xml).value!;
  await page.goto("/");
  const open = page.getByLabel("Open project", { exact: true });
  await open.setInputFiles({
    name: "sorting-conveyor.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    "No diagnostics",
  );
  const sources = page.getByRole("region", { name: "POUs", exact: true });
  for (const name of [
    "SortingConveyor PROGRAM",
    "Devices.IActuator INTERFACE",
    "Devices.Actuator CLASS",
    "Devices.ConveyorMotor CLASS",
    "Devices.Diverter CLASS",
    "IsActuatorActive FUNCTION",
    "PartCounter FUNCTION_BLOCK",
  ])
    await expect(
      sources.getByRole("button", { name: new RegExp(`^${name.replaceAll(".", "\\.")}`) }),
    ).toBeVisible();
  const panel = page.getByRole("region", { name: "Operator panel", exact: true });
  await expect(panel.locator(".positioned-part")).toHaveCount(10);
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
  const lamp = (name: string) => panel.getByRole("status", { name, exact: true });
  const total = (bin: string) =>
    panel.getByLabel(`BIN ${bin} TOTAL`, { exact: true }).locator("strong");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const monitorTotal = (bin: string) =>
    monitor
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name: `Bin${bin}Total`, exact: true }) })
      .locator("td")
      .nth(2);
  const press = async (name: string, expectedLamp: string, on: boolean) => {
    await panel.getByRole("button", { name, exact: true }).focus();
    await page.keyboard.down("Space");
    try {
      await expect(lamp(expectedLamp)).toHaveAttribute("data-on", String(on));
    } finally {
      await page.keyboard.up("Space");
    }
  };
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Scans", { exact: true })).not.toHaveText("0");
  await press("START", "BELT RUN", true);
  await press("PART A", "DIVERT A", true);
  await expect(lamp("DIVERT A")).toHaveAttribute("data-on", "false");
  await expect(lamp("DIVERT B")).toHaveAttribute("data-on", "false");
  await expect(total("A")).toHaveText("1");
  await expect(total("B")).toHaveText("0");
  await expect(monitorTotal("A")).toHaveText("1");
  await press("PART B", "DIVERT B", true);
  await expect(lamp("DIVERT B")).toHaveAttribute("data-on", "false");
  await expect(total("B")).toHaveText("1");
  await expect(monitorTotal("B")).toHaveText("1");
  await press("STOP BELT", "BELT RUN", false);
  const stop = page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true });
  await stop.click();
  await page.getByRole("button", { name: "Warm restart", exact: true }).click();
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  for (const bin of ["A", "B"]) {
    await expect(total(bin)).toHaveText("1");
    await expect(monitorTotal(bin)).toHaveText("1");
    await expect(lamp(`DIVERT ${bin}`)).toHaveAttribute("data-on", "false");
  }
  await expect(lamp("BELT RUN")).toHaveAttribute("data-on", "false");
  await press("START", "BELT RUN", true);
  await press("PART A", "DIVERT A", true);
  await expect(total("A")).toHaveText("2");
  await expect(monitorTotal("A")).toHaveText("2");
  await stop.click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  const saved = (await (await download).path())!;
  const reopened = readProject(readFileSync(saved, "utf8"));
  expect(reopened.diagnostics).toEqual([]);
  expect(reopened.value!.pous).toEqual(original.pous);
  expect(reopened.value!.panel).toEqual(original.panel);
  await open.setInputFiles(saved);
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  for (const bin of ["A", "B"]) await expect(total(bin)).toHaveText("0");
});

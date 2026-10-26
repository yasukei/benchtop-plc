import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject } from "@benchtop-plc/project";
import { autosaveStorageKey } from "../src/autosave.js";

const example = (name: string) =>
  readFileSync(new URL(`../../../examples/${name}/project.xml`, import.meta.url), "utf8");

test("shows M2's block values independently of M1 and autosaves the selection", async ({
  page,
}) => {
  const xml = example("motor-starters");
  const source = readProject(xml).value!.pous[1]!;
  const tripLine = source.split("\n").findIndex((line) => line.startsWith("Tripped :=")) + 1;
  await page.goto("/");
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "motors.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await page.getByRole("button", { name: /^MotorStarter FUNCTION_BLOCK/ }).click();
  const picker = page.getByRole("combobox", { name: "Instance", exact: true });
  await expect(picker).toHaveValue("mainInstance.M1");
  await picker.selectOption("mainInstance.M2");
  await expect(page.locator(".inline-values")).toHaveCount(0);
  await page.getByRole("switch", { name: "M2 OVERLOAD", exact: true }).click();
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  const tripped = page.locator(`.inline-values[data-line="${tripLine}"] .inline-bool`);
  await expect(tripped).toHaveText("TRUE");
  await picker.selectOption("mainInstance.M1");
  await expect(page.locator(".inline-values")).toHaveCount(0);
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(tripped).toHaveText("FALSE");
  await page.getByRole("searchbox", { name: "Filter instances", exact: true }).fill("m2");
  await expect(picker.locator("option:not([hidden])")).toHaveText(["mainInstance.M2"]);
  await picker.selectOption("mainInstance.M2");
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "{}").instanceChoices?.MOTORSTARTER,
        autosaveStorageKey,
      ),
    )
    .toBe("mainInstance.M2");
  await page.reload();
  await expect(picker).toHaveValue("mainInstance.M2");
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(tripped).toHaveText("FALSE");
  // Project files carry sources and configuration, but no workspace instance choices.
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "motors.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await page.getByRole("button", { name: /^MotorStarter FUNCTION_BLOCK/ }).click();
  await expect(picker).toHaveValue("mainInstance.M1");
});

test("selects the second TankControl PROGRAM instance and labels older task values", async ({
  page,
}) => {
  const xml = example("tank-station");
  const project = readProject(xml).value!;
  const alarmLine =
    project.pous[0]!.split("\n").findIndex((line) => line.trim() === "Alarm := TRUE;") + 1;
  await page.goto("/");
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "tanks.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  await page.getByRole("button", { name: /^TankControl PROGRAM/ }).click();
  const picker = page.getByRole("combobox", { name: "Instance", exact: true });
  await expect(picker).toHaveValue("Tank1");
  await picker.selectOption("Tank2");
  await page.getByRole("spinbutton", { name: "LEVEL 2 (%)", exact: true }).fill("90");
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(page.locator(`.inline-values[data-line="${alarmLine}"] .inline-bool`)).toHaveText(
    "TRUE",
  );
  await page.getByRole("button", { name: /^StationStatistics PROGRAM/ }).click();
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.locator(".inline-stale").first()).toHaveText(/^from scan \d+$/);
  await page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true }).click();
  await page.getByRole("button", { name: /^TankControl PROGRAM/ }).click();
  await expect(picker).toHaveValue("Tank2");
});

test("shows selected method calls on the sorting conveyor, derived class instances and function callers", async ({
  page,
}) => {
  const xml = example("sorting-conveyor");
  const project = readProject(xml).value!;
  const source = project.pous.find((source) => source.startsWith("FUNCTION_BLOCK PartCounter"))!;
  const countLine =
    source.split("\n").findIndex((line) => line.includes("Parts := Parts + 1;")) + 1;
  await page.goto("/");
  await page
    .getByLabel("Open project", { exact: true })
    .setInputFiles({ name: "sorting.xml", mimeType: "application/xml", buffer: Buffer.from(xml) });
  await page.getByRole("button", { name: /^IsActuatorActive FUNCTION/ }).click();
  await expect(page.getByText("No call recorded yet", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^PartCounter FUNCTION_BLOCK/ }).click();
  const picker = page.getByRole("combobox", { name: "Instance", exact: true });
  await expect(picker).toHaveValue("mainInstance.BINA");
  const count = page.locator(`.inline-values[data-line="${countLine}"] .inline-number`);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(count).toHaveCount(0);
  const panel = page.getByRole("region", { name: "Operator panel", exact: true });
  const press = async (name: string, lamp: string) => {
    await panel.getByRole("button", { name, exact: true }).focus();
    await page.keyboard.down("Space");
    try {
      await expect(panel.getByRole("status", { name: lamp, exact: true })).toHaveAttribute(
        "data-on",
        "true",
      );
    } finally {
      await page.keyboard.up("Space");
    }
  };
  await press("START", "BELT RUN");
  await press("PART A", "DIVERT A");
  await expect(count).toHaveText("1");
  await expect(
    page.locator(`.inline-values[data-line="${countLine}"] .inline-stale`),
  ).toBeVisible();
  await picker.selectOption("mainInstance.BINB");
  await expect(count).toHaveCount(0);
  await press("PART B", "DIVERT B");
  await expect(count).toHaveText("1");
  await page.getByRole("button", { name: /^Devices\.Actuator CLASS/ }).click();
  await expect(picker.locator("option")).toHaveText([
    "mainInstance.BELT (Devices.ConveyorMotor)",
    "mainInstance.GATEA (Devices.Diverter)",
    "mainInstance.GATEB (Devices.Diverter)",
  ]);
  await page.getByRole("button", { name: /^IsActuatorActive FUNCTION/ }).click();
  await expect(picker).toHaveCount(0);
  await expect(page.getByText(/Called from SortingConveyor \(mainInstance\), line/)).toBeVisible();
  await expect(page.locator(".inline-values .inline-bool")).toHaveText("TRUE");
});

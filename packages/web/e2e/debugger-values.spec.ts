import { expect, test } from "@playwright/test";
import { savePanelProject } from "../src/panel/project.js";

test("publishes a halt after a 64-bit call result and keeps the Worker responsive", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "long-call.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(
      savePanelProject(
        [
          `PROGRAM Main
VAR done : BOOL; END_VAR
LongValue();
done := TRUE;
END_PROGRAM`,
          "FUNCTION LongValue : LINT LongValue := LINT#9007199254740993; END_FUNCTION",
        ],
        [],
        10,
        null,
        [],
      )!,
    ),
  });
  await page.locator('.breakpoint-marker[data-line="4"]').click();
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state", { exact: true })).toHaveText("HALT");
  await expect(page.locator(".halt-banner")).toContainText("Main, line 4");
  await expect(page.locator('.inline-values[data-line="3"]')).toContainText("9007199254740993");
  await expect(page.getByRole("region", { name: "Call stack", exact: true })).toBeVisible();
  await page.locator('.breakpoint-marker[data-line="4"]').click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Runtime state", { exact: true })).toHaveText("RUN");
  await page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true }).click();
  await expect(page.getByLabel("Runtime state", { exact: true })).toHaveText("STOP");
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(page.locator('.inline-values[data-line="3"]')).toContainText("9007199254740993");
  expect(errors).toEqual([]);
});

test("shows invalid REAL in-out storage in both call stack languages and continues", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "invalid-in-out.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(
      savePanelProject(
        [
          `PROGRAM Main
VAR bits AT %MD0 : DWORD; r AT %MD0 : REAL; END_VAR
bits := DWORD#16#7FC00000;
Inspect(x := r);
END_PROGRAM`,
          `FUNCTION Inspect
VAR_IN_OUT x : REAL; END_VAR
RETURN;
END_FUNCTION`,
        ],
        [],
        10,
        null,
        [],
      )!,
    ),
  });
  await page.getByRole("button", { name: /^Inspect FUNCTION/ }).click();
  await page.locator('.breakpoint-marker[data-line="3"]').click();
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state", { exact: true })).toHaveText("HALT");
  await expect(page.locator(".halt-banner")).toContainText("Inspect, line 3");
  const stack = page.locator(".call-stack");
  await expect(stack.getByRole("listitem")).toHaveCount(2);
  await expect(stack.getByLabel("Frame values")).toContainText("Invalid (16#7FC00000)");
  await expect(stack.getByLabel("Frame values")).toContainText("mainInstance.r");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(stack).toContainText("無効 (16#7FC00000)");
  await page.getByRole("combobox", { name: "言語", exact: true }).selectOption("en");
  await page.locator('.breakpoint-marker[data-line="3"]').click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByLabel("Runtime state", { exact: true })).toHaveText("RUN");
  await page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true }).click();
  await expect(page.getByLabel("Runtime state", { exact: true })).toHaveText("STOP");
  expect(errors).toEqual([]);
});

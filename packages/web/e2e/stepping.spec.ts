import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test("steps into an interface call, inspects both frames, and steps out to the next conveyor actuator @debugger-shortcuts", async ({
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
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.press("Control+End");
  await editor.press("ArrowUp");
  await editor.press("ArrowUp");
  await page.locator('.breakpoint-marker[data-line="41"]').click();
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(page.locator(".halt-banner")).toContainText("SortingConveyor, line 41");
  await expect(page.locator(".runtime-halt-statement")).toHaveText(
    "Actuators[Index].Apply(Enable := Commands[Index]);",
  );

  const into = page.getByRole("button", { name: "Step into", exact: true });
  await expect(into).toHaveAttribute("title", "Step into (I)");
  await into.focus();
  await page.keyboard.press("i");
  await expect(page.locator(".halt-banner")).toContainText("Devices.ConveyorMotor.Apply, line 9");
  const stack = page.getByRole("region", { name: "Call stack", exact: true });
  await expect(stack.getByRole("listitem")).toHaveCount(2);
  await expect(stack.getByRole("button").nth(0)).toHaveText(
    "Devices.ConveyorMotor.Apply, line 9 (mainInstance.BELT)",
  );
  await expect(stack.getByRole("button").nth(1)).toHaveText(
    "SortingConveyor, line 41 (mainInstance)",
  );
  await expect(page.getByRole("combobox", { name: "Instance", exact: true })).toHaveValue(
    "mainInstance.BELT",
  );
  await expect(stack.getByLabel("Frame values")).toContainText("Enable");
  await expect(stack.getByLabel("Frame values")).toContainText("FALSE");

  // The method was unwatched at task start; its frame still records the completed assignment.
  await expect(into).toBeFocused();
  await page.keyboard.press("n");
  await expect(page.locator('.inline-values[data-line="9"]')).toContainText("0");
  await expect(page.locator(".runtime-halt-statement")).toHaveText("Active := SpeedPercent > 0;");
  await stack.getByRole("button").nth(1).click();
  await expect(stack.getByRole("button").nth(1)).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".runtime-halt-statement")).toHaveText(
    "Actuators[Index].Apply(Enable := Commands[Index]);",
  );
  await expect(page.getByRole("combobox", { name: "Instance", exact: true })).toHaveValue(
    "mainInstance",
  );
  await expect(page.locator('.inline-values[data-line="33"]')).toContainText("mainInstance.BELT");
  const index = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "Index", exact: true }) });
  await expect(index).toContainText("1");

  // Selection is inspection only: step out still leaves the executing method.
  await expect(stack.getByRole("button").nth(1)).toBeFocused();
  await page.keyboard.press("o");
  await expect(page.locator(".halt-banner")).toContainText("SortingConveyor, line 41");
  await expect(stack.getByRole("listitem")).toHaveCount(1);
  await expect(index).toContainText("2");
  await expect(page.locator(".runtime-halt-statement")).toHaveText(
    "Actuators[Index].Apply(Enable := Commands[Index]);",
  );
  await page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true }).click();
  await expect(stack).toHaveCount(0);
});

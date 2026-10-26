import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Keep the actions, statement lines and observations in sync with docs/debugging.md.
test("follows the sorting conveyor debugging guide", async ({ page }) => {
  const panel = page.getByRole("region", { name: "Operator panel", exact: true });
  const picker = page.getByRole("combobox", { name: "Instance", exact: true });
  const scans = page.getByLabel("Scans", { exact: true });
  const state = page.getByLabel("Runtime state", { exact: true });
  const stack = page.getByRole("region", { name: "Call stack", exact: true });
  const statement = page.locator(".runtime-halt-statement");
  const halt = page.locator(".halt-banner");
  const inline = (line: number) => page.locator(`.inline-values[data-line="${line}"]`);
  const marker = (line: number) => page.locator(`.breakpoint-marker[data-line="${line}"]`);
  const lamp = (name: string) => panel.getByRole("status", { name, exact: true });
  const total = (bin: string) =>
    panel.getByLabel(`BIN ${bin} TOTAL`, { exact: true }).locator("strong");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const value = (name: string) =>
    monitor
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name, exact: true }) })
      .locator("td")
      .nth(2);
  const selectSource = async (name: string) => {
    await page
      .getByRole("button", { name: new RegExp(`^${name.replaceAll(".", "\\.")} `) })
      .click();
  };
  const hold = async (name: string, observe: () => Promise<void>) => {
    await panel.getByRole("button", { name, exact: true }).focus();
    await page.keyboard.down("Space");
    try {
      await observe();
    } finally {
      await page.keyboard.up("Space");
    }
  };
  const advance = async () => {
    const previous = await scans.textContent();
    await expect(scans).not.toHaveText(previous!);
    await expect(state).toHaveText("RUN");
  };

  await test.step("1. Open a fresh project", async () => {
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
    await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
      "No diagnostics",
    );
    await expect(state).toHaveText("STOP");
    await expect(total("A")).toHaveText("0");
    await expect(total("B")).toHaveText("0");
    await selectSource("SortingConveyor");
    await expect(picker).toHaveValue("mainInstance");
  });

  await test.step("2. Choose a function block instance", async () => {
    await selectSource("PartCounter");
    await expect(picker).toHaveValue("mainInstance.BINA");
    await expect(page.locator(".inline-values")).toHaveCount(0);
    await page.getByRole("button", { name: "Single scan", exact: true }).click();
    await expect(inline(24).locator(".inline-number")).toHaveText("0");
    await expect(inline(21).locator(".inline-number")).toHaveText("0");
    await expect(lamp("BELT RUN")).toHaveAttribute("data-on", "false");
    const filter = page.getByRole("searchbox", { name: "Filter instances", exact: true });
    await filter.fill("binb");
    await expect(picker.locator("option:not([hidden])")).toHaveText(["mainInstance.BINB"]);
    await picker.selectOption("mainInstance.BINB");
    await expect(page.locator(".inline-values")).toHaveCount(0);
    await filter.fill("");
    await page.getByRole("button", { name: "Single scan", exact: true }).click();
    await expect(inline(24).locator(".inline-number")).toHaveText("0");
    await expect(inline(21).locator(".inline-number")).toHaveText("0");
    await page.getByRole("button", { name: "RUN", exact: true }).click();
    await advance();
    await hold("START", async () => {
      await expect(lamp("BELT RUN")).toHaveAttribute("data-on", "true");
    });
    await hold("PART B", async () => {
      await expect(lamp("DIVERT B")).toHaveAttribute("data-on", "true");
    });
    await expect(total("B")).toHaveText("1");
    await expect(inline(12).locator(".inline-number")).toHaveText("1");
    await expect(inline(12).locator(".inline-stale")).toHaveText(/^from scan \d+$/);
  });

  await test.step("3. Inspect class methods and a function", async () => {
    await selectSource("Devices.Diverter");
    await picker.selectOption("mainInstance.GATEB");
    await expect(inline(9).locator(".inline-number")).toHaveText("0");
    await hold("PART B", async () => {
      await expect(inline(9).locator(".inline-number")).toHaveText("90");
      await expect(lamp("DIVERT B")).toHaveAttribute("data-on", "true");
    });
    await expect(inline(9).locator(".inline-number")).toHaveText("0");
    await expect(lamp("DIVERT B")).toHaveAttribute("data-on", "false");
    await expect(total("B")).toHaveText("2");
    await selectSource("Devices.Actuator");
    await expect(picker.locator("option")).toHaveText([
      "mainInstance.BELT (Devices.ConveyorMotor)",
      "mainInstance.GATEA (Devices.Diverter)",
      "mainInstance.GATEB (Devices.Diverter)",
    ]);
    await picker.selectOption("mainInstance.BELT");
    await expect(inline(12).locator(".inline-bool")).toHaveText("TRUE");
    await picker.selectOption("mainInstance.GATEB");
    await expect(inline(12).locator(".inline-bool")).toHaveText("FALSE");
    await selectSource("IsActuatorActive");
    await expect(picker).toHaveCount(0);
    await expect(
      page.getByText("Called from SortingConveyor (mainInstance), line 43", { exact: true }),
    ).toBeVisible();
    await expect(inline(7).locator(".inline-bool")).toHaveText("TRUE");
  });

  await test.step("4. Halt only when a part arrives", async () => {
    await selectSource("PartCounter");
    await expect(picker).toHaveValue("mainInstance.BINB");
    await marker(3).click();
    await expect(marker(3)).toHaveAttribute("data-breakpoint", "inactive");
    await advance();
    await marker(3).click();
    await expect(marker(3)).toHaveAttribute("data-breakpoint", "none");
    await marker(12).click();
    await expect(marker(12)).toHaveAttribute("data-breakpoint", "active");
    await advance();
    await hold("PART A", async () => {
      await expect(halt).toContainText(
        "PartCounter.Count, line 12 (mainInstance.BINA), task Cyclic",
      );
    });
    await expect(state).toHaveText("HALT");
    await expect(picker).toHaveValue("mainInstance.BINA");
    await expect(statement).toHaveText("Parts := Parts + 1;");
    await expect(total("A")).toHaveText("0");
    await expect(lamp("BELT RUN")).toHaveAttribute("data-on", "true");
    await expect(lamp("DIVERT A")).toHaveAttribute("data-on", "false");
    await expect(page.getByRole("button", { name: "RUN", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Single scan", exact: true })).toBeDisabled();
    const image = page.getByRole("region", { name: "I/O image", exact: true });
    await expect(image.getByLabel("%IX0.2", { exact: true })).toHaveAttribute("data-on", "false");
    await expect(value("SensorA")).toHaveText("TRUE");
    const haltedScans = await scans.textContent();
    // Allow many 10 ms task intervals to pass to check the guide's frozen-Scans observation.
    await page.waitForTimeout(150);
    await expect(scans).toHaveText(haltedScans!);
    await expect(total("A")).toHaveText("0");
  });

  await test.step("5. Inspect the stack and step through publication", async () => {
    await expect(stack.getByRole("button")).toHaveText([
      "PartCounter.Count, line 12 (mainInstance.BINA)",
      "SortingConveyor, line 54 (mainInstance)",
    ]);
    await expect(value("BINA.PARTS")).toHaveText("0");
    await stack.getByRole("button").nth(1).click();
    await expect(statement).toHaveText("BinA.Count();");
    await expect(picker).toHaveValue("mainInstance");
    await expect(halt).toContainText("PartCounter.Count, line 12");
    await stack.getByRole("button").nth(0).click();
    await expect(statement).toHaveText("Parts := Parts + 1;");
    const over = page.getByRole("button", { name: "Step over", exact: true });
    await expect(over).toHaveAttribute("title", "Step over (N)");
    await over.focus();
    await page.keyboard.press("n");
    await expect(halt).toContainText("SortingConveyor, line 55");
    await expect(value("BINA.PARTS")).toHaveText("1");
    await expect(total("A")).toHaveText("0");
    await expect(over).toBeFocused();
    await page.keyboard.press("n");
    await expect(statement).toHaveText("BinA(Value => BinATotal);");
    await expect(halt).toContainText("SortingConveyor, line 57");
    await page.keyboard.press("i");
    await expect(halt).toContainText("PartCounter, line 24 (mainInstance.BINA)");
    await expect(statement).toHaveText("Value := THIS.Total();");
    await expect(stack.getByRole("listitem")).toHaveCount(2);
    await page.keyboard.press("i");
    await expect(halt).toContainText("PartCounter.Total, line 21 (mainInstance.BINA)");
    await expect(stack.getByRole("button")).toHaveText([
      "PartCounter.Total, line 21 (mainInstance.BINA)",
      "PartCounter, line 24 (mainInstance.BINA)",
      "SortingConveyor, line 57 (mainInstance)",
    ]);
    await expect(stack.getByLabel("Frame values")).toHaveText("Total0");
    await stack.getByRole("button").nth(2).click();
    await expect(statement).toHaveText("BinA(Value => BinATotal);");
    await page.keyboard.press("o");
    await expect(halt).toContainText("SortingConveyor, line 58");
    await expect(statement).toHaveText("BinB(Value => BinBTotal);");
    await expect(stack.getByRole("listitem")).toHaveCount(1);
    await expect(value("BinATotal")).toHaveText("1");
    await expect(total("A")).toHaveText("0");
    await page.getByRole("button", { name: "Continue", exact: true }).focus();
    await page.keyboard.press("c");
    await expect(total("A")).toHaveText("1");
    await expect(state).toHaveText("RUN");
    await expect(stack).toHaveCount(0);
    await expect(halt).toHaveCount(0);
    await expect(statement).toHaveCount(0);
    await expect(lamp("DIVERT A")).toHaveAttribute("data-on", "false");
    await advance();
    await expect(value("SensorA")).toHaveText("FALSE");
    await selectSource("PartCounter");
    await marker(12).click();
    await expect(marker(12)).toHaveAttribute("data-breakpoint", "none");
    await page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true }).click();
    await expect(state).toHaveText("STOP");
    await expect(lamp("BELT RUN")).toHaveAttribute("data-on", "false");
  });
});

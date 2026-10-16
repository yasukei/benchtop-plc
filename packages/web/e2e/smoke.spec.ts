import { expect, test } from "@playwright/test";

test("loads the demo and runs, stops, steps and resets through the Worker", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "benchtop-plc", exact: true })).toBeVisible();
  const state = page.getByLabel("Runtime state");
  const scans = page.getByLabel("Scans", { exact: true });
  await expect(state).toHaveText("STOP");
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(scans).toHaveText("1");
  await expect(state).toHaveText("STOP");
  await page.getByLabel("Cycle (ms)").selectOption("20");
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(state).toHaveText("RUN");
  await expect.poll(async () => Number(await scans.textContent())).toBeGreaterThan(1);
  await expect(page.getByRole("button", { name: "Single scan", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "STOP", exact: true }).click();
  await expect(state).toHaveText("STOP");
  await page.getByRole("button", { name: "Cold reset", exact: true }).click();
  await expect(scans).toHaveText("0");
  await expect(state).toHaveText("STOP");
  expect(errors).toEqual([]);
});

test("supports dark theme and a single column on narrow screens", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Theme").selectOption("dark");
  await expect(page.locator(".workbench")).toHaveAttribute("data-theme", "dark");
  const editor = page.getByRole("region", { name: "Structured Text" });
  const operator = page.getByRole("region", { name: "Operator panel" });
  const wideEditor = await editor.boundingBox();
  const wideOperator = await operator.boundingBox();
  expect(wideOperator!.x).toBeGreaterThan(wideEditor!.x + wideEditor!.width);
  await page.setViewportSize({ width: 390, height: 844 });
  const narrowEditor = await editor.boundingBox();
  const narrowOperator = await operator.boundingBox();
  expect(narrowOperator!.y).toBeGreaterThan(narrowEditor!.y + narrowEditor!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("shows Worker startup failures and disables runtime controls", async ({ page }) => {
  await page.route("**/assets/runtime.worker-*.js", (route) => route.abort());
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Worker is unavailable");
  for (const name of ["RUN", "STOP", "Single scan", "Cold reset"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
  }
});

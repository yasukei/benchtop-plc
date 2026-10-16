import { expect, test } from "@playwright/test";
import type { RuntimeSnapshot, RuntimeToUiMessage, UiToRuntimeMessage } from "@benchtop-plc/core";
import { demoProgram } from "../src/demo.js";

test("keeps the real Worker and RUN session alive after rejected debug commands", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        (window as Window & { testWorker?: Worker }).testWorker = this;
      }
    };
  });
  await page.goto("/");
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  const ir = structuredClone(demoProgram);
  ir.variables.push({
    kind: "scalar",
    name: "input",
    key: "INPUT",
    dataType: "BOOL",
    initialValue: false,
    address: { area: "I", byte: 0, bit: 0 },
    span: ir.span,
  });
  await page.evaluate((ir) => {
    const worker = (window as Window & { testWorker?: Worker }).testWorker;
    if (!worker) throw new Error("Expected runtime Worker");
    worker.postMessage({ type: "load", ir });
    worker.postMessage({ type: "force", variable: 0, value: { dataType: "DINT", value: 50 } });
  }, ir);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const commands: UiToRuntimeMessage[] = [
    { type: "write", variable: 1, value: { dataType: "BOOL", value: true } },
    { type: "force", variable: 999, value: null },
  ];
  for (const command of commands) {
    const snapshot = await page.evaluate(
      (command) =>
        new Promise<RuntimeSnapshot>((resolve) => {
          const worker = (window as Window & { testWorker?: Worker }).testWorker;
          if (!worker) throw new Error("Expected runtime Worker");
          let rejected = false;
          const listener = (event: MessageEvent<RuntimeToUiMessage>) => {
            if (event.data.type === "rejected") rejected = true;
            if (rejected && event.data.type === "snapshot") {
              worker.removeEventListener("message", listener);
              resolve(event.data.snapshot);
            }
          };
          worker.addEventListener("message", listener);
          worker.postMessage(command);
        }),
      command,
    );
    expect(snapshot.forced).toEqual([0]);
    expect(snapshot.variables).toMatchObject([
      { kind: "scalar", value: 50 },
      { kind: "scalar", value: false },
    ]);
    await expect(page.getByRole("alert")).toContainText(
      command.type === "write"
        ? "cannot write input-mapped variable input"
        : "select a scalar variable",
    );
    await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
    await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
    await expect(page.getByRole("alert")).toContainText(
      command.type === "write"
        ? "入力変数inputには書き込めません"
        : "スカラー変数を選択してください",
    );
    await expect(page.getByLabel("ランタイム状態")).toHaveText("RUN");
    await page.getByRole("combobox", { name: "言語", exact: true }).selectOption("en");
    await expect
      .poll(async () => Number(await page.getByLabel("Scans", { exact: true }).textContent()))
      .toBeGreaterThan(snapshot.scanCount);
    await expect(page.getByRole("button", { name: "STOP", exact: true })).toBeEnabled();
  }
  await page.getByRole("button", { name: "STOP", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  expect(errors).toEqual([]);
});

test("loads the demo and runs, stops, steps and resets through the Worker", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "benchtop-plc", exact: true })).toBeVisible();
  const state = page.getByLabel("Runtime state");
  const scans = page.getByLabel("Scans", { exact: true });
  await expect(state).toHaveText("STOP");
  const banner = page.locator(".banner");
  await expect(banner).toHaveText("Program loaded. Choose RUN or single scan to begin.");
  await expect(banner).toHaveAttribute("role", "status");
  await expect(banner).toHaveAttribute("data-urgent", "false");
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(scans).toHaveText("1");
  await expect(state).toHaveText("STOP");
  await page.getByLabel("Cycle (ms)").selectOption("20");
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(state).toHaveText("RUN");
  await expect(banner).toHaveText("The program is running in a Web Worker.");
  await expect.poll(async () => Number(await scans.textContent())).toBeGreaterThan(1);
  await expect(page.getByRole("button", { name: "Single scan", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "STOP", exact: true }).click();
  await expect(state).toHaveText("STOP");
  await expect(banner).toHaveText("Program loaded. Choose RUN or single scan to begin.");
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

import { expect, test } from "@playwright/test";

const workerPattern = "**/assets/runtime.worker-*.js";

test("switches the whole shell without reload and remembers the choice", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(page.getByLabel("Scans", { exact: true })).toHaveText("1");
  await page.evaluate(() => document.body.setAttribute("data-no-reload", "true"));
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.locator("body")).toHaveAttribute("data-no-reload", "true");
  await expect(page.getByLabel("スキャン数", { exact: true })).toHaveText("1");
  for (const name of ["単一スキャン", "コールドリセット"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  for (const name of ["操作パネル", "I/Oイメージ", "変数モニター"]) {
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  }
  await expect(page.getByLabel("テーマ")).toHaveValue("light");
  await expect(page.getByLabel("周期 (ms)")).toHaveValue("10");
  await expect(page.getByLabel("ランタイム状態")).toHaveText("STOP");
  await expect(page.locator(".banner")).toContainText("プログラムを読み込みました");
  await expect(page.getByText("ブラウザーPLCワークベンチ", { exact: true })).toBeVisible();
  await expect(page.getByText("プログラム適用済み", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "言語", exact: true })).toHaveValue("ja");
  await page.getByRole("combobox", { name: "言語", exact: true }).selectOption("en");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("heading", { name: "Operator panel", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Language", exact: true })).toHaveValue("en");
});

test("translates a displayed Worker diagnostic in place with its arguments", async ({ page }) => {
  // Inject a protocol fault at the Worker boundary without adding test hooks to the app.
  await page.route(workerPattern, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: `self.onmessage = () => {
      self.postMessage({type: "state", state: "FAULT"});
      self.postMessage({type: "fault", diagnostic: {
        code: "runtime.watchdog", severity: "error", args: {limit: 37}
      }});
    };`,
    }),
  );
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("Loop iteration limit (37) exceeded.");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(page.getByRole("alert")).toContainText(
    "ループの反復回数の上限（37回）を超えました。",
  );
  await expect(page.getByRole("alert")).not.toContainText("Loop iteration");
  await expect(page.getByLabel("ランタイム状態")).toHaveText("FAULT");
});

test("switches language when browser storage is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("Blocked");
      },
    });
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(page.getByRole("combobox", { name: "言語", exact: true })).toHaveValue("ja");
});

test.describe("Japanese browser", () => {
  test.use({ locale: "ja-JP" });
  test("uses Japanese initially, keeps saved English and fits a narrow viewport", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByRole("combobox", { name: "言語", exact: true })).toHaveValue("ja");
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.getByRole("combobox", { name: "言語", exact: true }).selectOption("en");
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Language", exact: true })).toHaveValue("en");
  });
});

test.describe("unsupported browser language", () => {
  test.use({ locale: "fr-FR" });
  test("defaults to English", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("combobox", { name: "Language", exact: true })).toHaveValue("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });
});

import { expect, test } from "@playwright/test";
import { autosaveStorageKey } from "../src/autosave.js";

const source = `PROGRAM Saved
VAR
  enabled : BOOL;
  count : DINT := 7;
END_VAR
count := count + 1;
END_PROGRAM`;

test("autosaves edits, moved panel parts, cycle and metadata during RUN and reloads in STOP without forces", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.fill(source);
  await page.getByLabel("Cycle (ms)").selectOption("50");
  await page.getByRole("button", { name: "Edit panel", exact: true }).click();
  const start = page.getByRole("button", { name: "START", exact: true });
  await start.click();
  await start.press("ArrowRight");
  await start.press("ArrowDown");
  await page.getByLabel("Label", { exact: true }).fill("Saved START");
  const moved = page.getByRole("button", { name: "Saved START", exact: true }).locator("..");
  const position = await moved.getAttribute("style");
  await page.getByRole("button", { name: "Operate", exact: true }).click();
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const enabled = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: /^enabled(?: Forced)?$/ }) });
  await enabled.getByRole("button", { name: "Force TRUE", exact: true }).click();
  await expect(enabled.getByText("Forced", { exact: true })).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "null")?.pous?.[0]?.source,
        autosaveStorageKey,
      ),
    )
    .toBe(source);
  const saved = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key)!),
    autosaveStorageKey,
  );
  expect(saved.cycleMs).toBe(50);
  expect(saved.layout[0].label).toBe("Saved START");
  expect(saved.project.contentHeader.name).toBeTruthy();
  await page.reload();
  await expect(editor.locator(".cm-line")).toHaveText(source.split("\n"));
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  await expect(page.getByLabel("Scans", { exact: true })).toHaveText("0");
  await expect(page.getByLabel("Cycle (ms)")).toHaveValue("50");
  await expect(enabled.getByText("Forced", { exact: true })).toHaveCount(0);
  await expect(enabled.getByText("FALSE", { exact: true })).toBeVisible();
  const count = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "count", exact: true }) });
  await expect(count.getByText("7", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Saved START", exact: true }).locator(".."),
  ).toHaveAttribute("style", position!);
});

test("keeps uncompilable editor text across reloads with diagnostics and no loaded program", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  const invalid = "PROGRAM Incomplete missing := 1; END_PROGRAM";
  await editor.fill(invalid);
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "null")?.pous?.[0]?.source,
        autosaveStorageKey,
      ),
    )
    .toBe(invalid);
  await page.reload();
  await expect(editor).toHaveText(invalid);
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    "missing",
  );
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  await expect(page.getByRole("button", { name: "Single scan", exact: true })).toBeDisabled();
  await editor.fill(source);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
});

test("flushes pending edits on immediate reload and autosaves Open example", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.fill(source);
  await page.reload();
  await expect(editor.locator(".cm-line")).toHaveText(source.split("\n"));
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open example", exact: true }).click();
  await page.getByRole("button", { name: "Open example", exact: true }).click();
  await expect(editor).toContainText("PROGRAM Main");
  await page.reload();
  await expect(editor).toContainText("PROGRAM Main");
  await expect(page.locator(".positioned-part")).toHaveCount(7);
});

for (const blocked of ["getter", "read", "write"] as const) {
  test(`starts with the example and keeps working when storage ${blocked} throws`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript((blocked) => {
      const fail = () => {
        throw new Error("Storage blocked");
      };
      if (blocked === "getter") Object.defineProperty(window, "localStorage", { get: fail });
      else
        Object.defineProperty(Storage.prototype, blocked === "read" ? "getItem" : "setItem", {
          value: fail,
        });
    }, blocked);
    await page.goto("/");
    await expect(page.getByRole("textbox", { name: "Structured Text", exact: true })).toContainText(
      "PROGRAM Main",
    );
    await expect(page.locator(".positioned-part")).toHaveCount(7);
    await page.getByLabel("Theme").selectOption("dark");
    await expect(page.locator(".workbench")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("textbox", { name: "Structured Text", exact: true }).fill(source);
    await page.getByRole("button", { name: "RUN", exact: true }).click();
    await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
    // Allow the actual autosave timer to attempt a write while the PLC keeps scanning.
    await expect
      .poll(async () => Number(await page.getByLabel("Scans", { exact: true }).textContent()))
      .toBeGreaterThan(60);
    expect(errors).toEqual([]);
  });
}

test("defaults to the dark OS scheme, persists explicit Light and follows live System changes", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  const theme = page.getByRole("combobox", { name: "Theme", exact: true });
  const workbench = page.locator(".workbench");
  await expect(theme).toHaveValue("system");
  await expect(workbench).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(workbench).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(workbench).toHaveAttribute("data-theme", "dark");
  await theme.selectOption("light");
  await page.reload();
  await expect(theme).toHaveValue("light");
  await expect(workbench).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(workbench).toHaveAttribute("data-theme", "light");
  await theme.selectOption("system");
  await expect(workbench).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(theme).toHaveValue("system");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(workbench).toHaveAttribute("data-theme", "light");
});

import { expect, test, type Page } from "@playwright/test";
import { autosaveStorageKey } from "../src/autosave.js";

const source = `PROGRAM Retained
VAR RETAIN kept : INT; ctr : CTU; END_VAR
VAR NON_RETAIN reset : INT; END_VAR
kept := kept + 1;
reset := reset + 1;
ctr(CU := TRUE, R := FALSE, PV := 10);
END_PROGRAM`;
const row = (page: Page, name: string) =>
  page.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });

async function apply(page: Page, text = source) {
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Structured Text", exact: true }).fill(text);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  await page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true }).click();
  await page.getByRole("button", { name: "Cold reset", exact: true }).click();
  await expect(row(page, "kept").locator("td").nth(2)).toHaveText("0");
}

test("retained scalar and counter survive page reload in STOP; warm restart and cold reset differ", async ({
  page,
}) => {
  await apply(page);
  for (let scan = 0; scan < 3; scan++)
    await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(row(page, "kept").locator("td").nth(2)).toHaveText("3");
  await expect(row(page, "reset").locator("td").nth(2)).toHaveText("3");
  await page.getByRole("button", { name: "Warm restart", exact: true }).click();
  await expect(row(page, "kept").locator("td").nth(2)).toHaveText("3");
  await expect(row(page, "reset").locator("td").nth(2)).toHaveText("0");
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          JSON.parse(localStorage.getItem(key)!).retentive.find((r: { path: string }) =>
            r.path.endsWith(".kept"),
          )?.value.value,
        autosaveStorageKey,
      ),
    )
    .toBe(3);
  await page.reload();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  await expect(page.getByLabel("Scans", { exact: true })).toHaveText("0");
  await expect(row(page, "kept").locator("td").nth(2)).toHaveText("3");
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(row(page, "kept").locator("td").nth(2)).toHaveText("4");
  await expect(row(page, "reset").locator("td").nth(2)).toHaveText("1");
  await expect(row(page, "ctr")).toContainText("CV=1");
  await page.getByRole("button", { name: "Cold reset", exact: true }).click();
  await expect(row(page, "kept").locator("td").nth(2)).toHaveText("0");
});

test("acknowledging a division-by-zero fault performs a warm restart into STOP", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Structured Text", exact: true })
    .fill(
      `PROGRAM Faulty VAR RETAIN kept : INT; END_VAR VAR zero : INT; result : INT; END_VAR kept := kept + 1; result := 10 / zero; END_PROGRAM`,
    );
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("FAULT");
  await expect(page.getByRole("button", { name: "RUN", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Acknowledge fault", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  await expect(row(page, "kept").locator("td").nth(2)).toHaveText("1");
  await expect(page.getByRole("button", { name: "Warm restart", exact: true })).toBeVisible();
});

test("reload reports changed and missing retained paths from unapplied source edits", async ({
  page,
}) => {
  await apply(page);
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Structured Text", exact: true })
    .fill(`PROGRAM Retained VAR RETAIN added : INT; ctr : CTD; END_VAR END_PROGRAM`);
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!).pous[0].source,
        autosaveStorageKey,
      ),
    )
    .toContain("added");
  await page.reload();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  const warning = page.getByRole("alert").filter({ hasText: "Retained values not restored (3)" });
  await expect(warning).toContainText("mainInstance.kept");
  await expect(warning).toContainText("mainInstance.ctr");
  await expect(warning).toContainText("mainInstance.added");
});

test("storage failure warns while retained execution continues", async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error("Full");
    };
  });
  await apply(page);
  await expect(
    page.getByRole("alert").filter({ hasText: "Retained values could not be saved" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(row(page, "kept").locator("td").nth(2)).toHaveText("1");
});

test("invalid autosaved edits preserve retained values across repeated reloads until compilation succeeds", async ({
  page,
}) => {
  await apply(page);
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(row(page, "kept").locator("td").nth(2)).toHaveText("1");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.fill("PROGRAM unfinished");
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!).pous[0].source,
        autosaveStorageKey,
      ),
    )
    .toBe("PROGRAM unfinished");
  for (let reload = 0; reload < 2; reload++) {
    await page.reload();
    await expect(editor.locator(".cm-line")).toHaveText(["PROGRAM unfinished"]);
    // A state-changing command before any successful load must not publish an empty retained set.
    await page.getByRole("button", { name: "Warm restart", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          (key) =>
            JSON.parse(localStorage.getItem(key)!).retentive.find((r: { path: string }) =>
              r.path.endsWith(".kept"),
            )?.value.value,
          autosaveStorageKey,
        ),
      )
      .toBe(1);
  }
  await editor.fill(source.replace("kept := kept + 1;", ""));
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  await page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true }).click();
  await expect(row(page, "kept").locator("td").nth(2)).toHaveText("1");
});

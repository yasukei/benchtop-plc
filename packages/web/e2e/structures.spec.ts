import { expect, test } from "@playwright/test";

test("expands a structure inside an array and forces and writes a scalar member", async ({
  page,
}) => {
  await page.goto("/");
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: "Add data type", exact: true }).click();
  await editor.fill("TYPE Point : STRUCT x : REAL; y : REAL := 1.0; END_STRUCT; END_TYPE");
  await list.getByRole("button", { name: /^Main PROGRAM/ }).click();
  await editor.fill(`PROGRAM Main
VAR pts : ARRAY[1..3] OF Point := [(x := 1.0), (x := 2.0), (x := 3.0)]; sum : REAL; i : INT; END_VAR
sum := 0.0;
FOR i := 1 TO 3 DO sum := sum + pts[i].x; END_FOR;
END_PROGRAM`);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const row = (name: string) =>
    monitor.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });
  const value = (name: string) => row(name).locator("td").nth(2);
  await expect(value("sum")).toHaveText("6.0");
  await expect(row("PTS[2].X")).toHaveCount(0);
  await monitor.getByRole("button", { name: "PTS", exact: true }).click();
  await expect(row("PTS[2].X")).toHaveCount(0);
  await monitor.getByRole("button", { name: "PTS[2]", exact: true }).click();
  await expect(value("PTS[2].X")).toHaveText("2.0");
  await expect(value("PTS[2].Y")).toHaveText("1.0");
  await row("PTS[2].X").getByLabel("Value to write").fill("10");
  await row("PTS[2].X").getByRole("button", { name: "Force", exact: true }).click();
  await expect(value("sum")).toHaveText("14.0");
  await monitor.getByRole("button", { name: "PTS", exact: true }).click();
  await expect(row("PTS[2].Y")).toHaveCount(0);
  await expect(row("PTS[2].X Forced")).toHaveAttribute("data-forced", "true");
  await monitor.getByRole("button", { name: "PTS", exact: true }).click();
  await row("PTS[2].Y").getByLabel("Value to write").fill("7");
  await row("PTS[2].Y").getByRole("button", { name: "Write", exact: true }).click();
  await expect(value("PTS[2].Y")).toHaveText("7.0");
});

test("explains unsupported function block members in English and Japanese", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("region", { name: "POUs", exact: true })
    .getByRole("button", { name: "Add data type", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.fill("TYPE Settings : STRUCT timerValue : TON; END_STRUCT; END_TYPE");
  const diagnostics = page.getByRole("region", { name: "Diagnostics", exact: true });
  await expect(diagnostics).toContainText(
    "Function block type TON is not supported in a structure.",
  );
  await expect(editor.locator(".cm-lintRange-error")).toHaveText("TON");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(page.getByRole("region", { name: "診断", exact: true })).toContainText(
    "TON はファンクションブロック型のため、構造体のメンバーには使用できません。",
  );
});

import { expect, test } from "@playwright/test";

test("runs open-array calls in the worker and monitors the caller's forced elements", async ({
  page,
}) => {
  await page.goto("/");
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: "Add function", exact: true }).click();
  await editor.fill(`FUNCTION Sum : DINT
VAR_IN_OUT a : ARRAY[*] OF INT; END_VAR
VAR i : DINT; END_VAR
FOR i := LOWER_BOUND(a, 1) TO UPPER_BOUND(a, 1) DO Sum := Sum + a[i]; END_FOR;
END_FUNCTION`);
  await list.getByRole("button", { name: /^Main PROGRAM/ }).click();
  await editor.fill(`PROGRAM Main
VAR a : ARRAY[1..3] OF INT := [1,2,3]; b : ARRAY[0..2] OF INT := [4,5,6]; x,y : DINT; END_VAR
x := Sum(a := a); y := Sum(a := b);
END_PROGRAM`);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const row = (name: string) =>
    monitor.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });
  await expect(row("x").locator("td").nth(2)).toHaveText("6");
  await expect(row("y").locator("td").nth(2)).toHaveText("15");
  await monitor.getByRole("button", { name: "A", exact: true }).click();
  await row("A[2]").getByLabel("Value to write").fill("10");
  await row("A[2]").getByRole("button", { name: "Force", exact: true }).click();
  await expect(row("x").locator("td").nth(2)).toHaveText("14");
});

test("explains open-array section restrictions in both languages", async ({ page }) => {
  await page.goto("/");
  await page
    .getByRole("region", { name: "POUs", exact: true })
    .getByRole("button", { name: "Add function", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Structured Text", exact: true })
    .fill("FUNCTION F VAR_INPUT a : ARRAY[*] OF INT; END_VAR END_FUNCTION");
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    "Open arrays are allowed only as direct VAR_IN_OUT parameters, with every dimension open.",
  );
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(page.getByRole("region", { name: "診断", exact: true })).toContainText(
    "可変長配列は VAR_IN_OUT 引数に直接宣言し、すべての次元を * にする必要があります。",
  );
});

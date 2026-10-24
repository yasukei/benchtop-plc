import { expect, test } from "@playwright/test";

test("shows reference targets changing from P1 to P2 without write or force controls", async ({
  page,
}) => {
  await page.goto("/");
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: "Add data type", exact: true }).click();
  await editor.fill("TYPE Point : STRUCT x : REAL; END_STRUCT; END_TYPE");
  await list.getByRole("button", { name: /^Main PROGRAM/ }).click();
  await editor.fill(`PROGRAM Main
VAR P1,P2 : Point; R : REF_TO Point; second : BOOL; END_VAR
R := MOVE(SEL(second, REF(P1), REF(P2)));
R^.x := R^.x + 5.0;
second := TRUE;
END_PROGRAM`);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  await page.locator(".toolbar").getByRole("button", { name: "STOP", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  await page.getByRole("button", { name: "Cold reset", exact: true }).click();
  await expect(page.getByLabel("Scans", { exact: true })).toHaveText("0");
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const row = (name: string) =>
    monitor.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });
  await expect(row("R").locator("td").nth(2)).toHaveText("P1");
  await expect(row("R").getByRole("button")).toHaveCount(0);
  await expect(row("R").getByLabel("Value to write")).toHaveCount(0);
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(row("R").locator("td").nth(2)).toHaveText("P2");
  await monitor.getByRole("button", { name: "P1", exact: true }).click();
  await monitor.getByRole("button", { name: "P2", exact: true }).click();
  await expect(row("P1.X").locator("td").nth(2)).toHaveText("5.0");
  await expect(row("P2.X").locator("td").nth(2)).toHaveText("5.0");
  await page.getByRole("button", { name: "Cold reset", exact: true }).click();
  await expect(row("R").locator("td").nth(2)).toHaveText("NULL");
});

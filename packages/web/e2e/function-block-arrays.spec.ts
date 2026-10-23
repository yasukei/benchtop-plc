import { expect, test } from "@playwright/test";

test("groups block elements and forces a user element member", async ({ page }) => {
  await page.goto("/");
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: "Add function block", exact: true }).click();
  await editor.fill(`FUNCTION_BLOCK MotorStarter
VAR_OUTPUT Q : BOOL; END_VAR
VAR running : BOOL; END_VAR
Q := running;
END_FUNCTION_BLOCK`);
  await list.getByRole("button", { name: /^Main PROGRAM/ }).click();
  await editor.fill(`PROGRAM Main
VAR m : ARRAY[1..2] OF MotorStarter; t : ARRAY[1..2] OF TON; seen : BOOL; END_VAR
m[2](Q => seen); t[2](IN := seen, PT := T#0ms);
END_PROGRAM`);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const row = (name: string) =>
    monitor.getByRole("row").filter({ has: page.getByRole("rowheader", { name, exact: true }) });
  const value = (name: string) => row(name).locator("td").nth(2);
  const member = monitor
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: /^M\[2\]\.RUNNING/ }) });
  await expect(member).toHaveCount(0);
  await monitor.getByRole("button", { name: "M", exact: true }).click();
  await expect(value("M[2].RUNNING")).toHaveText("FALSE");
  await member.getByRole("button", { name: "Force TRUE", exact: true }).click();
  await expect(value("seen")).toHaveText("TRUE");
  await expect(value("M[1].RUNNING")).toHaveText("FALSE");
  await monitor.getByRole("button", { name: "T", exact: true }).click();
  await expect(value("T[2]")).toContainText("Q=TRUE");
  await member.getByRole("button", { name: "Force FALSE", exact: true }).click();
  await expect(member).toHaveAttribute("data-forced", "true");
  await expect(value("seen")).toHaveText("FALSE");
  await expect(value("T[2]")).toContainText("Q=FALSE");
  await monitor.getByRole("button", { name: "M", exact: true }).click();
  await expect(row("M[1].RUNNING")).toHaveCount(0);
  await expect(member).toHaveAttribute("data-forced", "true");
});

test("shows the selected array variant in an uninstantiated block hover", async ({ page }) => {
  await page.goto("/");
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await list.getByRole("button", { name: "Add function block", exact: true }).click();
  await editor.fill(`FUNCTION_BLOCK CounterBank
VAR counters : ARRAY[1..2] OF CTU; END_VAR
counters[1](PV := DINT#40000);
END_FUNCTION_BLOCK`);
  const line = page.locator(".cm-line").filter({ hasText: /^counters\[1\]/ });
  await line.scrollIntoViewIfNeeded();
  const point = await line.evaluate((element) => {
    const text = element.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error("Expected counter text");
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, "counters".length);
    const rect = range.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await expect(page.locator(".cm-tooltip-hover")).toHaveText("counters: ARRAY[1..2] OF CTU_DINT");
});

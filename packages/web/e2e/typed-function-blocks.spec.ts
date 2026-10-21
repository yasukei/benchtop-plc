import { expect, test } from "@playwright/test";

test("runs new function blocks in the Worker and displays typed monitor ports", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(`PROGRAM Blocks
VAR setLatch: SR; resetLatch: RS; counter: CTUD_ULINT; timer: TON_LTIME; END_VAR
setLatch(S1 := TRUE, R := TRUE);
resetLatch(S := TRUE, R1 := TRUE);
counter(LD := TRUE, PV := ULINT#18446744073709551615);
timer(IN := TRUE, PT := LT#1500us);
END_PROGRAM`);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  for (const [name, value] of [
    ["setLatch", "Q1=TRUE"],
    ["resetLatch", "Q1=FALSE"],
    ["counter", "QU=TRUE, QD=FALSE, CV=18446744073709551615"],
    ["timer", "Q=TRUE, ET=LTIME#1ms500us"],
  ]) {
    const row = monitor.getByRole("row").filter({
      has: page.getByRole("rowheader", { name, exact: true }),
    });
    await expect(row.locator("td").nth(2)).toHaveText(value!);
  }
  await expect(page.locator(".st-fb").filter({ hasText: "TON_LTIME" })).toBeVisible();
});

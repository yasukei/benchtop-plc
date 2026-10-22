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

for (const scrolled of [false, true]) {
  test(`shows inferred timer and counter types in the monitor and editor hover${scrolled ? " with horizontal scrolling" : ""}`, async ({
    page,
  }) => {
    if (scrolled) await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto("/");
    const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
    await editor.click();
    await editor.press("ControlOrMeta+a");
    await page.keyboard.insertText(`PROGRAM Inferred
VAR counter: CTU; timer: TON; preset: DINT := 40000; END_VAR
counter(CU := TRUE, PV := preset);
timer(IN := TRUE, PT := LT#1500us);
END_PROGRAM`);
    await page.getByRole("button", { name: "RUN", exact: true }).click();
    await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
    const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
    const row = (name: string) =>
      monitor.getByRole("row").filter({
        has: page.getByRole("rowheader", { name, exact: true }),
      });
    await expect(row("counter").locator("td").nth(1)).toHaveText("CTU_DINT");
    await expect(row("timer").locator("td").nth(1)).toHaveText("TON_LTIME");
    await expect(row("timer").locator("td").nth(2)).toHaveText("Q=TRUE, ET=LTIME#1ms500us");
    const line = page.locator(".cm-line").filter({ hasText: /^counter\(/ });
    const scroller = page.locator(".cm-scroller");
    if (scrolled) {
      await scroller.evaluate((element) => {
        element.scrollLeft = 40;
      });
      expect(await scroller.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    }
    await line.scrollIntoViewIfNeeded();
    // Reveal the leading identifier so the sticky gutter cannot cover it.
    await scroller.evaluate((element) => {
      element.scrollLeft = 0;
    });
    const point = await line.evaluate((element) => {
      const text = element.firstChild;
      if (!text || text.nodeType !== Node.TEXT_NODE) throw new Error("Expected counter text");
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, "counter".length);
      const rect = range.getBoundingClientRect();
      const x = rect.x + rect.width / 2,
        y = rect.y + rect.height / 2;
      if (!element.contains(document.elementFromPoint(x, y)))
        throw new Error("Counter text is covered");
      return { x, y };
    });
    await page.mouse.move(point.x, point.y);
    await expect(page.locator(".cm-tooltip-hover")).toHaveText("counter: CTU_DINT");
  });
}

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

for (const form of ["named", "nested"] as const) {
  test(`explains unsupported ${form} instance arrays once in both languages`, async ({ page }) => {
    await page.goto("/");
    if (form === "named")
      await page
        .getByRole("region", { name: "POUs", exact: true })
        .getByRole("button", { name: "Add data type", exact: true })
        .click();
    const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
    await editor.fill(
      form === "named"
        ? "TYPE Timers : ARRAY[1..2] OF TON; END_TYPE"
        : "PROGRAM Main VAR timers : ARRAY[1..2] OF ARRAY[1..2] OF TON; END_VAR END_PROGRAM",
    );
    const english =
      form === "named"
        ? "Named function block array types are not supported; declare the instance array directly in a PROGRAM or FUNCTION_BLOCK VAR section."
        : "Function block instances are not supported inside nested array types; use a multidimensional instance array instead.";
    const japanese =
      form === "named"
        ? "ファンクションブロックの配列に名前付きの型は使用できません。PROGRAM または FUNCTION_BLOCK の VAR セクションで配列を直接宣言してください。"
        : "入れ子の配列型にはファンクションブロックを含められません。多次元のインスタンス配列を使用してください。";
    const diagnostics = page.getByRole("region", { name: "Diagnostics", exact: true });
    await expect(diagnostics.getByRole("listitem")).toHaveCount(1);
    await expect(diagnostics).toContainText(english);
    await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
    await expect(page.getByRole("region", { name: "診断", exact: true })).toContainText(japanese);
  });
}

test("names the scalar block type when it is indexed", async ({ page }) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.fill("PROGRAM Main VAR timer : TON; END_VAR timer[1](); END_PROGRAM");
  const diagnostics = page.getByRole("region", { name: "Diagnostics", exact: true });
  await expect(diagnostics).toContainText("Cannot index TON; an array is required.");
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(page.getByRole("region", { name: "診断", exact: true })).toContainText(
    "TON に添字は使えません。配列が必要です。",
  );
});

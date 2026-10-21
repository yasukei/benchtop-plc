import { expect, test } from "@playwright/test";

test("executes standard numeric functions and exact bit rotations in the Worker", async ({
  page,
}) => {
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await page.keyboard.insertText(`PROGRAM Functions
VAR rotated: LWORD; power: LREAL; selected: DINT; truncated: INT; flags: BOOL; END_VAR
rotated := ROR(LWORD#1, 1);
power := 2 ** 10;
selected := MUX(1, 10, 20, 30);
truncated := TRUNC_INT(-2.7);
flags := EQ(MAX(FALSE, TRUE), TRUE);
END_PROGRAM`);
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  for (const [name, value] of [
    ["rotated", "16#8000000000000000"],
    ["power", "1024.0"],
    ["selected", "20"],
    ["truncated", "-2"],
    ["flags", "TRUE"],
  ]) {
    const row = monitor
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name, exact: true }) });
    await expect(row.locator("td").nth(2)).toHaveText(value!);
  }
});

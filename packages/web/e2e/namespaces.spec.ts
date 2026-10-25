import { expect, test } from "@playwright/test";

test("lists a namespaced class by its qualified name and preserves it on reload", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const list = page.getByRole("region", { name: "POUs", exact: true });
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await list.getByRole("button", { name: "Add class", exact: true }).click();
  const source =
    "NAMESPACE Conveyor.Devices\nCLASS INTERNAL Motor\nMETHOD PUBLIC Run\nEND_METHOD\nEND_CLASS\nEND_NAMESPACE";
  await editor.fill(source);
  await expect(list.getByRole("button", { name: /^Conveyor\.Devices\.Motor CLASS/ })).toBeVisible();
  await page.reload();
  await list.getByRole("button", { name: /^Conveyor\.Devices\.Motor CLASS/ }).click();
  await expect(editor.locator(".cm-line")).toHaveText(source.split("\n"));
});

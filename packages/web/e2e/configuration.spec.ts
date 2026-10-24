import { expect, test } from "@playwright/test";

test("groups implicit instance paths and names the instance supplying inline values", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const monitor = page.getByRole("region", { name: "Variable monitor", exact: true });
  const instance = monitor.getByRole("button", { name: "mainInstance", exact: true });
  await expect(instance).toHaveAttribute("aria-expanded", "true");
  await expect(monitor.getByRole("rowheader", { name: "Lamp", exact: true })).toHaveAttribute(
    "title",
    "mainInstance.Lamp",
  );
  await expect(page.getByText("Instance: mainInstance", { exact: true })).toBeVisible();
  await instance.click();
  await expect(monitor.getByRole("rowheader", { name: "Lamp", exact: true })).toHaveCount(0);
  await instance.click();
  await expect(monitor.getByRole("rowheader", { name: "Lamp", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Single scan", exact: true }).click();
  await expect(page.locator(".inline-values").first()).toBeVisible();
});

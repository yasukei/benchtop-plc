import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { readProject, writeProject } from "@benchtop-plc/project";
import type { RuntimeToUiMessage, UiToRuntimeMessage } from "@benchtop-plc/core";

test("applies a type change while an old zero-scan Worker reply is delayed", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      private stringSnapshots = 0;
      private delayed?: RuntimeToUiMessage;
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener("message", (event: MessageEvent<RuntimeToUiMessage>) => {
          const message = event.data;
          if (
            message.type === "snapshot" &&
            message.snapshot.scanCount === 0 &&
            message.snapshot.variables.some(
              (value) => value.kind === "scalar" && value.dataType === "STRING",
            )
          ) {
            this.stringSnapshots++;
            // Deliver the load's initial snapshot, but hold its watchBodies reply.
            if (this.stringSnapshots === 2) {
              this.delayed = message;
              document.documentElement.dataset.delayedSnapshot = "held";
              event.stopImmediatePropagation();
            }
          }
        });
      }
      override postMessage(message: UiToRuntimeMessage) {
        if (message.type === "load" && this.delayed) {
          const delayed = this.delayed;
          this.delayed = undefined;
          this.dispatchEvent(new MessageEvent("message", { data: delayed }));
          document.documentElement.dataset.delayedSnapshot = "delivered";
        }
        super.postMessage(message);
      }
    };
  });
  await page.goto("/");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  const project = readProject(
    readFileSync(new URL("../../../examples/blink/project.xml", import.meta.url), "utf8"),
  ).value!;
  project.dataTypes = ["TYPE State : (Idle, Done); END_TYPE"];
  project.pous = ["PROGRAM Main\nVAR x : STRING := 'abc'; END_VAR\nEND_PROGRAM"];
  project.panel = [];
  const xml = writeProject(project).value!;
  await page.getByLabel("Open project", { exact: true }).setInputFiles({
    name: "string.xml",
    mimeType: "application/xml",
    buffer: Buffer.from(xml),
  });
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "x", exact: true }) });
  await expect(row.locator("td").nth(2)).toHaveText("'abc'");
  await expect(page.locator("html")).toHaveAttribute("data-delayed-snapshot", "held");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  await editor.fill("PROGRAM Main\nVAR x : State := State#Done; END_VAR\nEND_PROGRAM");
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-delayed-snapshot", "delivered");
  await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  await expect(row.locator("td").nth(2)).toHaveText("Done");
  expect(errors).toEqual([]);
});

for (const action of ["Acknowledge fault", "Cold reset"]) {
  test(action + " clears a failed-load diagnostic and allows retry", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      const OriginalWorker = window.Worker;
      window.Worker = class extends OriginalWorker {
        override postMessage(message: UiToRuntimeMessage) {
          if (message.type === "load" && document.documentElement.dataset.failLoad === "true") {
            document.documentElement.dataset.failLoad = "false";
            const command = structuredClone(message);
            const variable = command.ir.variables[0]!;
            if (variable.kind !== "scalar") throw new Error("Expected scalar fixture");
            variable.initialValue = "invalid integer";
            super.postMessage(command);
          } else super.postMessage(message);
        }
      };
    });
    await page.goto("/");
    await expect(page.getByText("Program applied", { exact: true })).toBeVisible();
    await page
      .getByRole("textbox", { name: "Structured Text", exact: true })
      .fill("PROGRAM Main VAR x : INT := 7; END_VAR END_PROGRAM");
    await page.evaluate(() => {
      document.documentElement.dataset.failLoad = "true";
    });
    await page.getByRole("button", { name: "RUN", exact: true }).click();
    const alert = page.getByRole("alert").filter({ hasText: "The program could not be loaded." });
    await expect(alert).toBeVisible();
    await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
    await page.getByRole("button", { name: action, exact: true }).click();
    await expect(alert).toHaveCount(0);
    await expect(page.getByRole("rowheader", { name: "x", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "RUN", exact: true }).click();
    await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
    const row = page.getByRole("row").filter({
      has: page.getByRole("rowheader", { name: "x", exact: true }),
    });
    await expect(row.locator("td").nth(2)).toHaveText("7");
    expect(errors).toEqual([]);
  });
}

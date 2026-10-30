import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { build } from "vite";
import { MAX_SOURCE_NESTING } from "@benchtop-plc/compiler";
import { writeProject } from "@benchtop-plc/project";
import { autosaveStorageKey } from "../src/autosave.js";
import {
  nestingCases,
  nestingSource,
  failedOperandsProject,
} from "../../../tests/conformance/source-nesting.test-support.js";

test("the deepest accepted source compiles, runs and round-trips in a browser Worker", async ({
  page,
}) => {
  const built = await build({
    configFile: false,
    logLevel: "silent",
    resolve: { conditions: ["@benchtop-plc/source", "module", "browser"] },
    build: {
      write: false,
      lib: {
        entry: fileURLToPath(new URL("./fixtures/source-nesting.worker.ts", import.meta.url)),
        formats: ["iife"],
        name: "SourceNestingWorker",
      },
    },
  });
  const bundle = Array.isArray(built) ? built[0]! : built;
  if (!("output" in bundle)) throw new Error("Expected a completed build");
  const output = bundle.output[0]!;
  if (output.type !== "chunk") throw new Error("Expected a Worker bundle");
  await page.goto("/");
  const result = await page.evaluate(
    (code) =>
      new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        const worker = new Worker(url);
        worker.onmessage = ({ data }) => {
          worker.terminate();
          URL.revokeObjectURL(url);
          resolve(data);
        };
        worker.onerror = (error) => {
          worker.terminate();
          URL.revokeObjectURL(url);
          reject(new Error(error.message));
        };
        worker.postMessage(null);
      }),
    output.code,
  );
  expect(result).toEqual({
    failedOperands: [
      { kind: "calls", bounded: true },
      { kind: "comparisons", bounded: true },
    ],
    results: nestingCases.map((kind) => ({
      kind,
      preserved: true,
      diagnostics: [],
      fault: null,
      value: expect.objectContaining({ kind: "scalar", value: 1 }),
      rejected: ["syntax.nesting-limit"],
    })),
  });
});

for (const kind of ["calls", "comparisons"] as const) {
  test(`restores accepted-depth ${kind} with type errors without repeating failed checks`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const depth = kind === "calls" ? MAX_SOURCE_NESTING : MAX_SOURCE_NESTING / 2;
    const project = failedOperandsProject(kind, depth);
    const written = writeProject(project);
    expect(written.diagnostics).toEqual([]);
    await page.goto("/");
    await page.getByLabel("Open project", { exact: true }).setInputFiles({
      name: "failed-operands.xml",
      mimeType: "application/xml",
      buffer: Buffer.from(written.value!),
    });
    const diagnostics = page.getByRole("region", { name: "Diagnostics", exact: true });
    await expect(diagnostics).toContainText(kind === "calls" ? "MAX" : "zz");
    await page.reload();
    await expect(diagnostics).toContainText(kind === "calls" ? "MAX" : "zz");
    await page
      .getByRole("textbox", { name: "Structured Text", exact: true })
      .fill("PROGRAM Main VAR c : Color; END_VAR c := Color#Red; END_PROGRAM");
    await page.getByRole("button", { name: "RUN", exact: true }).click();
    await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
    expect(errors).toEqual([]);
  });
}

test("deep autosaved text returns a localized diagnostic and the editor stays usable", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  const editor = page.getByRole("textbox", { name: "Structured Text", exact: true });
  const source = nestingSource("parentheses", 10_000);
  await editor.fill(source);
  const message = `Source nesting exceeds the limit of ${MAX_SOURCE_NESTING} levels.`;
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    message,
  );
  await expect
    .poll(() =>
      page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key) ?? "null")?.pous?.[0]?.source,
        autosaveStorageKey,
      ),
    )
    .toBe(source);
  await page.reload();
  await expect(page.getByRole("region", { name: "Diagnostics", exact: true })).toContainText(
    message,
  );
  await expect(page.getByLabel("Runtime state")).toHaveText("STOP");
  await expect(page.getByRole("button", { name: "Single scan", exact: true })).toBeDisabled();
  await page.getByRole("combobox", { name: "Language", exact: true }).selectOption("ja");
  await expect(page.getByRole("region", { name: "診断", exact: true })).toContainText(
    `ソースの入れ子が上限の${MAX_SOURCE_NESTING}段を超えています。`,
  );
  await page.getByRole("combobox", { name: "言語", exact: true }).selectOption("en");
  await editor.fill(nestingSource("parentheses", MAX_SOURCE_NESTING));
  await page.getByRole("button", { name: "RUN", exact: true }).click();
  await expect(page.getByLabel("Runtime state")).toHaveText("RUN");
  const row = page
    .getByRole("row")
    .filter({ has: page.getByRole("rowheader", { name: "x", exact: true }) });
  await expect(row.locator("td").nth(2)).toHaveText("1");
  expect(errors).toEqual([]);
});

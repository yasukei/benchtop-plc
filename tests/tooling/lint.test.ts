import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import { expect, it } from "vitest";

// Clock restrictions are syntax-only; virtual fixture paths need no TypeScript project.
const syntaxLint = new ESLint({ overrideConfig: tseslint.configs.disableTypeChecked });
const typedLint = new ESLint();

it.each(["core", "compiler", "runtime", "project"])(
  "requires injected time in %s source, tests and fixtures",
  async (name) => {
    for (const path of ["probe.ts", "probe.test.ts", "fixtures/probe.ts"]) {
      const filePath = `packages/${name}/src/${path}`;
      for (const source of [
        "Date.now();",
        'Date["now"]();',
        "performance.now();",
        'performance["now"]();',
        "globalThis.Date.now();",
        'globalThis["Date"]["now"]();',
        "globalThis.performance.now();",
        'globalThis["performance"]["now"]();',
        "new Date();",
        "new globalThis.Date();",
        'new globalThis["Date"]();',
        "Date();",
        "Date(0);",
        "globalThis.Date();",
        'globalThis["Date"]();',
        "setTimeout(() => {}, 1);",
        "setInterval(() => {}, 1);",
        "globalThis.setTimeout(() => {}, 1);",
        'globalThis["setInterval"](() => {}, 1);',
        "export const timer = setTimeout;",
        "export const timer = setInterval;",
        "[1].map(setTimeout);",
      ]) {
        const [result] = await syntaxLint.lintText(source, { filePath });
        expect(result?.messages).toEqual([
          expect.objectContaining({
            ruleId: expect.stringMatching(/^no-restricted-(syntax|globals)$/),
            message: expect.stringMatching(/injected (Clock|Ticker)/),
          }),
        ]);
      }
      const [result] = await syntaxLint.lintText(
        "export const stamp = new Date(0); export const qualified = new globalThis.Date(0); " +
          'export const computed = new globalThis["Date"](0); export const year = stamp.getUTCFullYear();',
        { filePath },
      );
      expect(result?.messages).toEqual([]);
    }
  },
);

it("allows host clocks and timers in the browser adapter", async () => {
  const [result] = await syntaxLint.lintText(
    "Date.now(); performance.now(); new Date(); setTimeout(() => {}, 1); setInterval(() => {}, 1);",
    { filePath: "packages/web/src/probe.ts" },
  );
  expect(result?.messages).toEqual([]);
});

it.each([
  "vitest.config.ts",
  "packages/runtime/src/clock.test.ts",
  "packages/web/src/autosave.ts",
  "packages/web/src/worker-host.ts",
  "packages/web/e2e/editor.spec.ts",
  "packages/web/vite.config.ts",
])(
  "checks promises and discriminated switches in %s",
  async (filePath) => {
    const [result] = await typedLint.lintText(
      `
        export function probe(kind: "load" | "loaded"): void {
          Promise.resolve();
          [1].forEach(async () => { await Promise.resolve(); });
          switch (kind) { case "load": break; }
        }
      `,
      { filePath },
    );
    expect(result?.messages.map((message) => message.ruleId).sort()).toEqual([
      "@typescript-eslint/no-floating-promises",
      "@typescript-eslint/no-misused-promises",
      "@typescript-eslint/switch-exhaustiveness-check",
    ]);
    const [valid] = await typedLint.lintText(
      `
        export async function probe(kind: "load" | "loaded"): Promise<void> {
          await Promise.resolve();
          [1].forEach(() => {});
          switch (kind) { case "load": break; case "loaded": break; }
        }
      `,
      { filePath },
    );
    expect(valid?.messages).toEqual([]);
  },
  30_000,
);

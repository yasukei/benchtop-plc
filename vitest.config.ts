import { defineConfig } from "vitest/config";

// Resolve workspace packages to their TypeScript sources (see the package "exports"), so tests
// need no prior build. Tests run in Vite's server environment; the other entries are Vite's
// default server conditions, which setting this option replaces.
const conditions = ["@benchtop-plc/source", "module", "node", "development|production"];

export default defineConfig({
  ssr: { resolve: { conditions } },
  test: {
    include: ["packages/*/src/**/*.test.{ts,tsx}", "tests/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}", "**/*.test-support.ts", "**/*.d.ts"],
      reportsDirectory: "coverage",
      reporter: ["text-summary", "html", "json-summary"],
      reportOnFailure: true,
    },
  },
});

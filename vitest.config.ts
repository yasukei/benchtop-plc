import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Resolve workspace packages to their TypeScript sources (see the package "exports").
    conditions: ["@benchtop-plc/source"],
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "tests/conformance/**/*.test.ts"],
    environment: "node",
  },
});

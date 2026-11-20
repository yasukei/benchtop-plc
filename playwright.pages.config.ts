import { defineConfig } from "@playwright/test";
import { baseConfig, readPort, reuseExistingServer } from "./playwright.shared.js";

const port = readPort("E2E_PAGES_PORT", 14274);
const baseURL = `http://127.0.0.1:${port}/benchtop-plc/`;

// Serves the GitHub Pages build under its sub-path and runs the smoke tests against it.
export default defineConfig(baseConfig, {
  projects: baseConfig.projects.filter((project) => project.name === "chromium"),
  testMatch: "smoke.spec.ts",
  use: { baseURL },
  webServer: {
    command:
      "pnpm --filter @benchtop-plc/web build:pages && " +
      `pnpm --filter @benchtop-plc/web preview:pages --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    stdout: "pipe",
    reuseExistingServer,
  },
});

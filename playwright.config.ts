import { defineConfig } from "@playwright/test";
import { baseConfig, readPort, reuseExistingServer } from "./playwright.shared.js";

const port = readPort("E2E_PORT", 14273);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig(baseConfig, {
  use: { baseURL },
  webServer: {
    // CI builds in an earlier step; local runs build before starting preview.
    command:
      (process.env.CI ? "" : "pnpm build && ") +
      `pnpm --filter @benchtop-plc/web preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer,
  },
});

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./packages/web/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
      },
    },
    // Keep the full suite on Chromium; only debugger shortcuts need all three engines.
    {
      name: "firefox",
      grep: /@debugger-shortcuts/,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      grep: /@debugger-shortcuts/,
      use: { ...devices["Desktop Safari"] },
    },
  ],
  webServer: {
    // CI builds in an earlier step; local runs build before starting preview.
    command:
      (process.env.CI ? "" : "pnpm build && ") +
      "pnpm --filter @benchtop-plc/web preview --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
  },
});

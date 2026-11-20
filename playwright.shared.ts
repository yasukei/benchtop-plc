import { devices, type PlaywrightTestConfig } from "@playwright/test";

export const baseConfig = {
  testDir: "./packages/web/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { trace: "retain-on-failure" },
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
} satisfies PlaywrightTestConfig;

export const reuseExistingServer =
  process.env.CI === undefined && process.env.PW_REUSE_SERVER === "1";

export function readPort(variable: string, defaultPort: number): number {
  const value = process.env[variable];
  if (value === undefined) return defaultPort;

  const port = Number(value);
  if (!/^[0-9]+$/.test(value) || port < 1 || port > 65535) {
    throw new Error(`${variable} must be an integer from 1 to 65535.`);
  }
  return port;
}

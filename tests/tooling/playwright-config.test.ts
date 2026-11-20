import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("CI", undefined);
  vi.stubEnv("PW_REUSE_SERVER", undefined);
  vi.stubEnv("E2E_PORT", undefined);
  vi.stubEnv("E2E_PAGES_PORT", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe.each([
  {
    name: "app",
    loadConfig: () => import("../../playwright.config.js"),
    variable: "E2E_PORT",
    otherVariable: "E2E_PAGES_PORT",
    defaultPort: 14273,
    path: "",
  },
  {
    name: "Pages",
    loadConfig: () => import("../../playwright.pages.config.js"),
    variable: "E2E_PAGES_PORT",
    otherVariable: "E2E_PORT",
    defaultPort: 14274,
    path: "/benchtop-plc/",
  },
])("$name Playwright config", ({ loadConfig, variable, otherVariable, defaultPort, path }) => {
  it("starts its own server on the suite's default port", async () => {
    const { default: config } = await loadConfig();
    const url = `http://127.0.0.1:${defaultPort}${path}`;
    expect(config.use?.baseURL).toBe(url);
    expect(config.webServer).toMatchObject([
      {
        url,
        command: expect.stringContaining(`--port ${defaultPort} --strictPort`),
        reuseExistingServer: false,
      },
    ]);
  });

  it("uses only its own port override and allows local server reuse", async () => {
    vi.stubEnv(variable, "65535");
    vi.stubEnv(otherVariable, "invalid");
    vi.stubEnv("PW_REUSE_SERVER", "1");
    const { default: config } = await loadConfig();
    const url = `http://127.0.0.1:65535${path}`;
    expect(config.use?.baseURL).toBe(url);
    expect(config.webServer).toMatchObject([
      {
        url,
        command: expect.stringContaining("--port 65535 --strictPort"),
        reuseExistingServer: true,
      },
    ]);
  });

  it.each(["true", "0"])("requires the exact reuse flag, rejecting %s", async (flag) => {
    vi.stubEnv("PW_REUSE_SERVER", flag);
    const { default: config } = await loadConfig();
    expect(config.webServer).toMatchObject([{ reuseExistingServer: false }]);
  });

  it.each(["true", ""])("disables reuse whenever CI is set to %j", async (ci) => {
    vi.stubEnv("CI", ci);
    vi.stubEnv("PW_REUSE_SERVER", "1");
    const { default: config } = await loadConfig();
    expect(config.webServer).toMatchObject([{ reuseExistingServer: false }]);
  });

  it.each(["abc", "", "0", "70000", "1.5", "1e3", "0x10", " 1 "])(
    "rejects invalid ports such as %j",
    async (port) => {
      vi.stubEnv(variable, port);
      await expect(loadConfig()).rejects.toThrow(`${variable} must be an integer from 1 to 65535.`);
    },
  );
});

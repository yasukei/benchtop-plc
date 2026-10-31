import { describe, expect, it } from "vitest";
import {
  catalogs,
  createAppStore,
  createI18n,
  cycleOptions,
  formatDiagnostic,
  initialLanguage,
  RuntimeClient,
} from "./index.js";
import type { AppStore, CycleMs, I18n } from "./index.js";
import { FakeWorker } from "./fake-worker.test-support.js";

describe("@benchtop-plc/web public API", () => {
  it("connects the app store to the runtime client and shared cycle settings", () => {
    const worker = new FakeWorker();
    const client = new RuntimeClient(worker);
    const store: AppStore = createAppStore(client, "PROGRAM Empty END_PROGRAM");
    try {
      expect(cycleOptions).toEqual([10, 20, 50, 100]);
      for (const ms of cycleOptions) {
        const cycle: CycleMs = ms;
        store.send({ type: "setCycle", ms: cycle });
        expect(store.getSnapshot().cycleMs).toBe(cycle);
        expect(worker.sent.at(-1)).toEqual({ type: "setCycle", ms: cycle });
      }
      worker.receive({ type: "state", state: "RUN" });
      expect(store.getSnapshot().runtimeState).toBe("RUN");
      expect(() => store.send({ type: "setCycle", ms: 15 })).toThrow("Unsupported cycle");
    } finally {
      store.dispose();
      client.dispose();
    }
    expect(worker.terminated).toBe(true);
  });

  it("exposes language selection, catalogs and diagnostic formatting", () => {
    const language = initialLanguage({ languages: ["ja-JP"] });
    const i18n: I18n = createI18n({ languages: [language] });
    expect(i18n.getSnapshot()).toBe("ja");
    i18n.setLanguage("en");
    expect(i18n.getSnapshot()).toBe("en");
    expect(catalogs.en.title).toBe("benchtop-plc");
    const diagnostic = {
      code: "runtime.watchdog",
      severity: "error",
      args: { limit: 123 },
    } as const;
    expect(formatDiagnostic("en", diagnostic)).toContain("123");
    expect(formatDiagnostic("ja", diagnostic)).toContain("123");
    expect(formatDiagnostic("en", diagnostic)).not.toBe(formatDiagnostic("ja", diagnostic));
  });
});

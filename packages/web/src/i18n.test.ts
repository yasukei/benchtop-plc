import { describe, expect, it, vi } from "vitest";
import { createI18n, initialLanguage, languageStorageKey } from "./i18n.js";

describe("language preferences", () => {
  it.each([
    [[], "en"],
    [["fr-FR"], "en"],
    [["ja-JP", "en-US"], "ja"],
    [["fr", "JA-jp", "en"], "ja"],
    [["en-GB", "ja"], "en"],
  ] as const)("chooses a supported language from %j", (languages, expected) => {
    expect(initialLanguage({ languages })).toBe(expected);
  });

  it("prefers a saved language and ignores invalid stored values", () => {
    const storage = { getItem: vi.fn(() => "en"), setItem: vi.fn() };
    expect(initialLanguage({ languages: ["ja-JP"], storage })).toBe("en");
    expect(storage.getItem).toHaveBeenCalledWith(languageStorageKey);
    storage.getItem.mockReturnValue("de");
    expect(initialLanguage({ languages: ["ja-JP"], storage })).toBe("ja");
  });

  it("persists changes and notifies subscribers without a reload", () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };
    const onChange = vi.fn();
    const i18n = createI18n({ storage, onChange });
    const listener = vi.fn();
    const unsubscribe = i18n.subscribe(listener);
    expect(i18n.getSnapshot()).toBe("en");
    expect(onChange).toHaveBeenCalledWith("en");
    i18n.setLanguage("ja");
    expect(i18n.getSnapshot()).toBe("ja");
    expect(storage.setItem).toHaveBeenCalledWith(languageStorageKey, "ja");
    expect(onChange).toHaveBeenLastCalledWith("ja");
    expect(listener).toHaveBeenCalledTimes(1);
    i18n.setLanguage("ja");
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    i18n.setLanguage("en");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps working if storage reads and writes are blocked", () => {
    const blocked = () => {
      throw new Error("Storage blocked");
    };
    const i18n = createI18n({ languages: ["ja"], storage: { getItem: blocked, setItem: blocked } });
    expect(i18n.getSnapshot()).toBe("ja");
    expect(() => i18n.setLanguage("en")).not.toThrow();
    expect(i18n.getSnapshot()).toBe("en");
  });
});

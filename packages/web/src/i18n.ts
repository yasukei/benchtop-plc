import { catalogs, type Language } from "./catalog.js";

export const languageStorageKey = "benchtop-plc.language";

export interface LanguagePreferences {
  languages?: readonly string[];
  storage?: Pick<Storage, "getItem" | "setItem">;
  onChange?: (language: Language) => void;
}

export function isLanguage(value: unknown): value is Language {
  return value === "en" || value === "ja";
}

/** Prefer a saved selection, then the first supported browser language, then English. */
export function initialLanguage({ languages = [], storage }: LanguagePreferences): Language {
  try {
    const saved = storage?.getItem(languageStorageKey);
    if (isLanguage(saved)) return saved;
  } catch {
    // Storage may be blocked by browser privacy settings.
  }
  for (const tag of languages) {
    const language = tag.toLowerCase().split("-")[0];
    if (isLanguage(language)) return language;
  }
  return "en";
}

export function createI18n(preferences: LanguagePreferences = {}) {
  let language = initialLanguage(preferences);
  const listeners = new Set<() => void>();
  preferences.onChange?.(language);
  return {
    getSnapshot: () => language,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setLanguage(next: Language) {
      if (next === language) return;
      language = next;
      try {
        preferences.storage?.setItem(languageStorageKey, next);
      } catch {
        // Switching still works when persistence is unavailable.
      }
      preferences.onChange?.(next);
      for (const listener of listeners) listener();
    },
  };
}

export type I18n = ReturnType<typeof createI18n>;

export function createBrowserI18n(): I18n {
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    // Access to the storage property itself can throw.
  }
  return createI18n({
    languages: navigator.languages,
    storage,
    onChange(language) {
      document.documentElement.lang = language;
      document.title = catalogs[language].title;
    },
  });
}

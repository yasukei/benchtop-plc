import { browserStorage, type BrowserStorage } from "./browser-storage.js";

export const themeStorageKey = "benchtop-plc.theme";
export type Theme = "system" | "light" | "dark";

export function isTheme(value: unknown): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

interface ColorScheme {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}

export function createTheme({
  storage,
  scheme,
}: { storage?: BrowserStorage; scheme?: ColorScheme } = {}) {
  let selection: Theme = "system";
  try {
    const saved = storage?.getItem(themeStorageKey);
    if (isTheme(saved)) selection = saved;
  } catch {
    // System remains the default when storage is blocked.
  }
  const resolve = () => (selection === "system" ? (scheme?.matches ? "dark" : "light") : selection);
  let snapshot = { selection, resolved: resolve() };
  const listeners = new Set<() => void>();
  const update = () => {
    const resolved = resolve();
    if (snapshot.selection === selection && snapshot.resolved === resolved) return;
    snapshot = { selection, resolved };
    for (const listener of listeners) listener();
  };
  scheme?.addEventListener("change", update);
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setTheme(next: Theme) {
      if (selection === next) return;
      selection = next;
      try {
        storage?.setItem(themeStorageKey, next);
      } catch {
        // Switching still works when persistence is unavailable.
      }
      update();
    },
    dispose() {
      scheme?.removeEventListener("change", update);
      listeners.clear();
    },
  };
}

export type ThemeStore = ReturnType<typeof createTheme>;

export function createBrowserTheme(): ThemeStore {
  return createTheme({
    storage: browserStorage(),
    scheme: window.matchMedia("(prefers-color-scheme: dark)"),
  });
}

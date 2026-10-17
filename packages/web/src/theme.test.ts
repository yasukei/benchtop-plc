import { describe, expect, it, vi } from "vitest";
import { createTheme, themeStorageKey } from "./theme.js";

function colorScheme(matches = true) {
  const listeners = new Set<() => void>();
  return {
    matches,
    addEventListener: (_: "change", listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_: "change", listener: () => void) => {
      listeners.delete(listener);
    },
    change(matches: boolean) {
      this.matches = matches;
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

describe("theme preferences", () => {
  it("defaults to System and follows live OS changes with stable snapshots", () => {
    const scheme = colorScheme();
    const theme = createTheme({ scheme });
    expect(theme.getSnapshot()).toEqual({ selection: "system", resolved: "dark" });
    expect(theme.getSnapshot()).toBe(theme.getSnapshot());
    const listener = vi.fn();
    const unsubscribe = theme.subscribe(listener);
    scheme.change(false);
    expect(theme.getSnapshot()).toEqual({ selection: "system", resolved: "light" });
    expect(listener).toHaveBeenCalledTimes(1);
    scheme.change(false);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    scheme.change(true);
    expect(listener).toHaveBeenCalledTimes(1);
    theme.dispose();
    expect(scheme.listeners.size).toBe(0);
  });

  it.each(["light", "dark", "system"] as const)("restores saved %s", (selection) => {
    const storage = { getItem: vi.fn(() => selection), setItem: vi.fn() };
    const theme = createTheme({ storage, scheme: colorScheme() });
    expect(theme.getSnapshot()).toEqual({
      selection,
      resolved: selection === "system" ? "dark" : selection,
    });
    expect(storage.getItem).toHaveBeenCalledWith(themeStorageKey);
    theme.dispose();
  });

  it("persists explicit choices, ignores OS changes until System and disposes listeners", () => {
    const scheme = colorScheme();
    const storage = { getItem: () => null, setItem: vi.fn() };
    const theme = createTheme({ scheme, storage });
    const listener = vi.fn();
    theme.subscribe(listener);
    theme.setTheme("light");
    expect(storage.setItem).toHaveBeenLastCalledWith(themeStorageKey, "light");
    scheme.change(false);
    scheme.change(true);
    expect(theme.getSnapshot()).toEqual({ selection: "light", resolved: "light" });
    expect(listener).toHaveBeenCalledTimes(1);
    theme.setTheme("light");
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    theme.setTheme("system");
    expect(storage.setItem).toHaveBeenLastCalledWith(themeStorageKey, "system");
    expect(theme.getSnapshot()).toEqual({ selection: "system", resolved: "dark" });
    theme.dispose();
    scheme.change(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("ignores invalid saved choices and tolerates absent or throwing storage", () => {
    expect(createTheme().getSnapshot()).toEqual({ selection: "system", resolved: "light" });
    expect(
      createTheme({ storage: { getItem: () => "invalid", setItem: vi.fn() } }).getSnapshot()
        .selection,
    ).toBe("system");
    const blocked = () => {
      throw new Error("Blocked");
    };
    const theme = createTheme({
      storage: { getItem: blocked, setItem: blocked },
      scheme: colorScheme(),
    });
    expect(theme.getSnapshot().resolved).toBe("dark");
    expect(() => theme.setTheme("light")).not.toThrow();
    expect(theme.getSnapshot().resolved).toBe("light");
    theme.dispose();
  });
});

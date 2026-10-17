export type BrowserStorage = Pick<Storage, "getItem" | "setItem">;

export function browserStorage(): BrowserStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    // Access to the storage property itself can throw in private or blocked contexts.
    return undefined;
  }
}

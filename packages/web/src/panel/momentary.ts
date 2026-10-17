/** Multiple activation sources keep an input ON until the final source releases it. */
export function createMomentaryInput(send: (value: boolean) => void) {
  const sources = new Set<string>();
  return {
    set(source: string, active: boolean) {
      const wasHeld = sources.size > 0;
      if (active) sources.add(source);
      else sources.delete(source);
      const isHeld = sources.size > 0;
      if (wasHeld !== isHeld) send(isHeld);
    },
    release() {
      if (!sources.size) return;
      sources.clear();
      send(false);
    },
  };
}

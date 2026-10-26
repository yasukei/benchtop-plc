import {
  formatValue,
  type CallFrame,
  type CallValue,
  type RuntimeSnapshot,
  type UiToRuntimeMessage,
} from "@benchtop-plc/core";

export const stepLabels = { over: "stepOver", into: "stepInto", out: "stepOut" } as const;
export const debugBindings = { continue: "C", over: "N", into: "I", out: "O" } as const;

interface DebugKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
}

/** Plain letters are available in every browser/OS; typing and composition keep their keys. */
export function debugShortcut(
  key: DebugKey,
  enabled: boolean,
  editing: boolean,
): UiToRuntimeMessage | null {
  if (
    !enabled ||
    editing ||
    key.ctrlKey ||
    key.metaKey ||
    key.altKey ||
    key.shiftKey ||
    key.repeat ||
    key.isComposing
  )
    return null;
  const binding = Object.entries(debugBindings).find(
    ([, value]) => value === key.key.toUpperCase(),
  )?.[0];
  if (binding === "continue") return { type: "continue" };
  return binding === "over" || binding === "into" || binding === "out"
    ? { type: "debugStep", kind: binding }
    : null;
}

export function frameMatchesSource(
  frame: CallFrame | undefined,
  pou: string | undefined,
  instance?: string,
): boolean {
  if (!frame || !pou || (instance !== undefined && frame.instance !== instance)) return false;
  const name = pou.toUpperCase();
  const running = frame.pou.toUpperCase();
  return running === name || (frame.kind === "METHOD" && running.startsWith(`${name}.`));
}

/** Replace the selected invocation, rather than mixing it with an older watched invocation. */
export function frameSnapshot(
  snapshot: RuntimeSnapshot | null,
  frame: CallFrame | undefined,
): RuntimeSnapshot | null {
  if (!snapshot || !frame) return snapshot;
  const name = frame.pou.toUpperCase();
  return {
    ...snapshot,
    annotations: [
      ...snapshot.annotations.filter(
        (body) => body.pou.toUpperCase() !== name || body.instance !== frame.instance,
      ),
      {
        pou: frame.pou,
        instance: frame.instance,
        scanCount: snapshot.scanCount + 1,
        lines: frame.annotations,
        ...(frame.caller ? { caller: frame.caller } : {}),
      },
    ],
  };
}

export function formatCallValue(value: CallValue): string {
  if ("kind" in value && value.kind === "aggregate")
    return value.elements
      .map((element) => `${element.name}: ${formatCallValue(element.value)}`)
      .join(", ");
  return "target" in value ? (value.target ?? "NULL") : formatValue(value.dataType, value.value);
}

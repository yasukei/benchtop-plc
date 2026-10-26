import type { DebugStepKind } from "@benchtop-plc/core";

/** Identities, rather than depths, distinguish a caller from its next callee. */
export interface PendingStep {
  kind: DebugStepKind;
  origin: readonly object[];
}

export function stepReached(step: PendingStep, frames: readonly object[]): boolean {
  if (step.kind === "into") return true;
  const current = frames.at(-1);
  const allowed = step.kind === "over" ? step.origin : step.origin.slice(0, -1);
  return (
    allowed.includes(current!) ||
    // The last PROGRAM returned: the next instance/task/pass is a valid destination.
    !frames.some((frame) => step.origin.includes(frame))
  );
}

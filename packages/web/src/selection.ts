import type { SavedWork } from "./autosave.js";

/** Non-POU tabs remember the POU to return to when their source is deleted. */
export type Selection =
  | { kind: "pou"; index: number }
  | { kind: "dataType"; index: number; pouIndex: number }
  | { kind: "configuration"; pouIndex: number };

export type SavedSelection = Pick<
  SavedWork,
  "selectedPou" | "selectedDataType" | "selectedConfiguration"
>;

export function selectionFromSaved(saved: SavedSelection): Selection {
  if (saved.selectedConfiguration) return { kind: "configuration", pouIndex: saved.selectedPou };
  if (saved.selectedDataType !== null)
    return { kind: "dataType", index: saved.selectedDataType, pouIndex: saved.selectedPou };
  return { kind: "pou", index: saved.selectedPou };
}

/** Compatibility boundary for React consumers and the version 4 autosave format. */
export function savedSelection(selection: Selection): SavedSelection {
  return {
    selectedPou: selectedPouIndex(selection),
    selectedDataType: selection.kind === "dataType" ? selection.index : null,
    selectedConfiguration: selection.kind === "configuration",
  };
}

export function selectedPouIndex(selection: Selection): number {
  return selection.kind === "pou" ? selection.index : selection.pouIndex;
}

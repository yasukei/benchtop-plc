import { indentMore } from "@codemirror/commands";
import { indentUnit } from "@codemirror/language";
import type { StateCommand } from "@codemirror/state";

/** Indent selected code without replacing it; empty selections insert spaces. */
export const insertSpacesOrIndent: StateCommand = ({ state, dispatch }) => {
  if (state.selection.ranges.some((range) => !range.empty)) return indentMore({ state, dispatch });
  dispatch(
    state.update(state.replaceSelection(state.facet(indentUnit)), {
      scrollIntoView: true,
      userEvent: "input",
    }),
  );
  return true;
};

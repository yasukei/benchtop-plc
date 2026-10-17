import { EditorSelection, EditorState } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import { insertSpacesOrIndent } from "./commands.js";

function pressTab(doc: string, ranges: readonly [number, number][]) {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.create(
      ranges.map(([anchor, head]) => EditorSelection.range(anchor, head)),
    ),
    extensions: [indentUnit.of("  "), EditorState.allowMultipleSelections.of(true)],
  });
  expect(
    insertSpacesOrIndent({
      state,
      dispatch: (transaction) => {
        state = transaction.state;
      },
    }),
  ).toBe(true);
  return state;
}

describe("Tab indentation", () => {
  it("inserts spaces at empty selections", () => {
    const state = pressTab("xy", [[1, 1]]);
    expect(state.doc.toString()).toBe("x  y");
    expect(state.selection.main.head).toBe(3);
  });

  it("indents a line with a partial selection without deleting the selected code", () => {
    const state = pressTab("value := 1;", [[2, 5]]);
    expect(state.doc.toString()).toBe("  value := 1;");
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe("lue");
  });

  it("preserves and indents all selected lines with a reversed selection", () => {
    const source = "x := 1;\ny := 2;";
    const state = pressTab(source, [[source.length, 0]]);
    expect(state.doc.toString()).toBe("  x := 1;\n  y := 2;");
    expect(state.selection.main.anchor).toBeGreaterThan(state.selection.main.head);
    expect(state.doc.toString()).not.toContain("\t");
  });

  it("inserts spaces at each cursor when all selections are empty", () => {
    const state = pressTab("x\ny", [
      [0, 0],
      [2, 2],
    ]);
    expect(state.doc.toString()).toBe("  x\n  y");
    expect(state.selection.ranges.map((range) => range.head)).toEqual([2, 6]);
  });
});

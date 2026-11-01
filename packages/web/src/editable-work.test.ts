import { ChangeSet } from "@codemirror/state";
import { expect, it } from "vitest";
import {
  addSource,
  createEditableWork,
  deleteSource,
  editSource,
  recompileWork,
  replaceWork,
  selectWork,
  type EditableWork,
  type WorkTransition,
} from "./editable-work.js";
import { createPous, deriveDataType } from "./pous.js";
import { openPanelProject, savePanelProject } from "./panel/project.js";
import { savedSelection, selectionFromSaved, type Selection } from "./selection.js";

const main = "PROGRAM Main\nVAR n : INT; END_VAR\nn := n + 1;\nEND_PROGRAM";
const block = "FUNCTION_BLOCK Block\nVAR n : INT; END_VAR\nn := n + 2;\nEND_FUNCTION_BLOCK";
const apply = (work: EditableWork, transition: WorkTransition | undefined): EditableWork => ({
  ...work,
  ...transition?.patch,
});

// Freeze nested values too: transitions must not mutate the workspace or persisted maps.
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}

it.each<Selection>([
  { kind: "pou", index: 1 },
  { kind: "dataType", index: 2, pouIndex: 1 },
  { kind: "configuration", pouIndex: 1 },
])("round trips $kind selection through the existing persistence fields", (selection) => {
  expect(selectionFromSaved(savedSelection(selection))).toEqual(selection);
});

it.each([
  ["function", "FUNCTION"],
  ["functionBlock", "FUNCTION_BLOCK"],
  ["class", "CLASS"],
  ["interface", "INTERFACE"],
  ["dataType", "TYPE"],
  ["configuration", "CONFIGURATION"],
] as const)("adds and compiles a %s without changing the original work", (kind, header) => {
  const work = freeze(createEditableWork(main));
  const next = apply(work, addSource(work, kind));
  expect(next.source.startsWith(header)).toBe(true);
  expect(next.editorSession).toBe(1);
  expect(next.diagnostics).toEqual([]);
  expect(next.editorIr).toBeDefined();
  expect(work.pous).toHaveLength(1);
  expect(work.source).toBe(main);
  if (kind === "interface") expect(next.pous[1]).toBe(work.pous[0]);
  if (kind === "configuration") expect(addSource(next, kind)).toBeUndefined();
});

it("keeps selection, source and the remembered POU together across tab deletion", () => {
  let work: EditableWork = { ...createEditableWork(main), pous: createPous([main, block]) };
  work = apply(work, selectWork(work, { kind: "pou", index: 1 }));
  work = apply(work, addSource(work, "dataType"));
  work = apply(work, addSource(work, "configuration"));
  work = apply(work, deleteSource(freeze(work), "configuration"));
  expect(work.selection).toEqual({ kind: "pou", index: 1 });
  expect(work.source).toBe(block);
  work = apply(work, selectWork(work, { kind: "dataType", index: 0, pouIndex: 1 }));
  work = apply(work, deleteSource(freeze(work), "dataType", 0));
  expect(work.selection).toEqual({ kind: "pou", index: 1 });
  expect(work.source).toBe(block);
});

it("adjusts list indexes while keeping an open type or configuration selected", () => {
  let work: EditableWork = {
    ...createEditableWork(main),
    pous: createPous([block, main]),
    selection: { kind: "pou", index: 1 } as Selection,
    source: main,
  };
  work = apply(work, addSource(work, "dataType"));
  work = apply(work, addSource(work, "dataType"));
  work = apply(work, deleteSource(freeze(work), "dataType", 0));
  expect(work.selection).toEqual({ kind: "dataType", index: 0, pouIndex: 1 });
  expect(work.source).toContain("Type2");
  work = apply(work, deleteSource(freeze(work), "pou", 0));
  expect(work.selection).toEqual({ kind: "dataType", index: 0, pouIndex: 0 });
  expect(work.source).toContain("Type2");
  work = apply(work, addSource(work, "configuration"));
  const source = work.source;
  work = apply(work, deleteSource(freeze(work), "dataType", 0));
  expect(work.selection).toEqual({ kind: "configuration", pouIndex: 0 });
  expect(work.source).toBe(source);
});

it("ignores invalid, repeated or protected selections and deletions", () => {
  const work = freeze(createEditableWork(main));
  expect(selectWork(work, work.selection)).toBeUndefined();
  expect(selectWork(work, { kind: "pou", index: 5 })).toBeUndefined();
  expect(selectWork(work, { kind: "dataType", index: 0, pouIndex: 0 })).toBeUndefined();
  expect(selectWork(work, { kind: "configuration", pouIndex: 0 })).toBeUndefined();
  expect(deleteSource(work, "pou", 0)).toBeUndefined();
  expect(deleteSource(work, "pou", 5)).toBeUndefined();
  expect(deleteSource(work, "dataType", 0)).toBeUndefined();
  expect(deleteSource(work, "configuration")).toBeUndefined();
  expect(editSource(work, main)).toBeUndefined();
});

it("preserves drafts and previous names independently for every source kind", () => {
  for (const kind of ["functionBlock", "dataType", "configuration"] as const) {
    const work = freeze(apply(createEditableWork(main), addSource(createEditableWork(main), kind)));
    const next = apply(work, editSource(work, "(* unfinished"));
    const selected =
      kind === "functionBlock"
        ? next.pous[1]
        : kind === "dataType"
          ? next.dataTypes[0]
          : next.configuration;
    expect(selected?.source).toBe("(* unfinished");
    expect(selected?.name).toBe(
      kind === "functionBlock" ? "FB1" : kind === "dataType" ? "Type1" : "Config",
    );
    expect(next.editorIr).toBeUndefined();
    expect(next.diagnostics).toEqual([]);
    expect(recompileWork(next).diagnostics.length).toBeGreaterThan(0);
  }
});

it("moves breakpoints with exact edits and returns the mapping effect for the coordinator", () => {
  const work = freeze({ ...createEditableWork(main), breakpoints: { MAIN: [3] } });
  const changes = ChangeSet.of({ from: 0, insert: "// inserted\n" }, main.length);
  const transition = editSource(work, "// inserted\n" + main, changes)!;
  expect(transition.patch.breakpoints).toEqual({ MAIN: [4] });
  expect(transition.mappings?.edit).toEqual({
    pou: work.pous[0],
    source: "// inserted\n" + main,
    changes,
  });
  expect(work.breakpoints).toEqual({ MAIN: [3] });
});

it("parks colliding names and rekeys debug entries together when the headers swap", () => {
  let work: EditableWork = {
    ...createEditableWork(main),
    pous: createPous([main, block]),
    breakpoints: { MAIN: [3], BLOCK: [3] },
    instanceChoices: { MAIN: "mainInstance", BLOCK: "mainInstance.b" },
  };
  work = apply(work, editSource(freeze(work), main.replace("Main", "Block")));
  expect(work.pous.map((pou) => pou.name)).toEqual(["Main", "Block"]);
  work = apply(work, selectWork(work, { kind: "pou", index: 1 }));
  const transition = editSource(freeze(work), block.replace("Block", "Main"))!;
  work = apply(work, transition);
  expect(work.pous.map((pou) => pou.name)).toEqual(["Block", "Main"]);
  expect(work.instanceChoices).toEqual({ BLOCK: "mainInstance", MAIN: "mainInstance.b" });
  expect(transition.mappings?.renames).toEqual(
    new Map([
      ["MAIN", "BLOCK"],
      ["BLOCK", "MAIN"],
    ]),
  );
});

it("deletes debug entries and releases a pending rename without mutating persisted maps", () => {
  let work: EditableWork = {
    ...createEditableWork(main),
    pous: createPous([main, block]),
    breakpoints: { MAIN: [3], BLOCK: [3] },
    instanceChoices: { MAIN: "mainInstance", BLOCK: "mainInstance.b" },
  };
  work = apply(work, editSource(work, main.replace("Main", "Block")));
  const transition = deleteSource(freeze(work), "pou", 1)!;
  const next = apply(work, transition);
  expect(next.pous[0]?.name).toBe("Block");
  expect(next.breakpoints).toEqual({ BLOCK: [3] });
  expect(next.instanceChoices).toEqual({ BLOCK: "mainInstance" });
  expect(transition.mappings?.removed).toBe("BLOCK");
  expect(transition.mappings?.renames).toEqual(new Map([["MAIN", "BLOCK"]]));
});

it("replaces all editable project work, clears old debug state, and compiles explicit configuration", () => {
  let work = createEditableWork(main);
  work = apply(work, addSource(work, "configuration"));
  const opened = openPanelProject(savePanelProject([main], [], 50, null, [], work.source)!)!;
  const previous = freeze({
    ...work,
    breakpoints: { MAIN: [3] },
    instanceChoices: { MAIN: "old" },
    retentive: [],
  });
  const next = apply(previous, replaceWork(previous, opened, 50));
  expect(next.selection).toEqual({ kind: "pou", index: 0 });
  expect(next.source).toBe(main);
  expect(next.configuration?.source).toBe(work.source);
  expect(next.editorIr?.explicit).toBe(true);
  expect(next.breakpoints).toBeUndefined();
  expect(next.instanceChoices).toBeUndefined();
  expect(next.retentive).toBeUndefined();
  expect(next.cycleMs).toBe(50);
});

it("creates a first POU in an empty project and recompiles all sources together", () => {
  const work = freeze({ ...createEditableWork(""), pous: [] });
  const next = apply(work, editSource(work, main));
  expect(next.pous[0]?.name).toBe("Main");
  expect(recompileWork(next).editorIr).toBeDefined();
  const typed = {
    ...next,
    dataTypes: [deriveDataType("TYPE Count : INT; END_TYPE")],
    pous: createPous([main.replace("INT", "Count")]),
  };
  expect(recompileWork(typed).editorIr).toBeDefined();
  expect(recompileWork({ ...typed, dataTypes: [] }).diagnostics).toContainEqual(
    expect.objectContaining({ code: "decl.unknown-type", args: { name: "Count" } }),
  );
});

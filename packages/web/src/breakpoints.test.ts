import { expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import { compileProject } from "@benchtop-plc/compiler";
import { haltPoints, mapBreakpointLines, mapSourceLines } from "./breakpoints.js";

it("moves markers and loaded line origins through insertions and deletions", () => {
  const before = "PROGRAM Main\nn := 1;\nn := 2;\nEND_PROGRAM";
  const after = "PROGRAM Main\n\nn := 1;\nn := 2;\nEND_PROGRAM";
  expect(mapBreakpointLines(before, after, [2, 3])).toEqual([3, 4]);
  expect(mapSourceLines(before, after, [1, 2, 3, 4])).toEqual([1, null, 2, 3, 4]);
  const removed = "PROGRAM Main\nn := 2;\nEND_PROGRAM";
  expect(mapBreakpointLines(before, removed, [2, 3])).toEqual([2]);
  expect(mapSourceLines(before, removed, [1, 2, 3, 4])).toEqual([1, 3, 4]);
});

it("preserves a marker during inline edits and renames, and removes a deleted last line", () => {
  expect(mapBreakpointLines("n := 1;", "n := 100;", [1])).toEqual([1]);
  expect(mapBreakpointLines("PROGRAM Main\nn := 1;", "PROGRAM Renamed\nn := 1;", [2])).toEqual([2]);
  expect(mapBreakpointLines("a\nb", "a", [2])).toEqual([]);
});

it("keeps inserted lines without an origin across subsequent edits", () => {
  const before = "a\nb\nc",
    after = "a\nnew\nb\nc";
  const origins = mapSourceLines(before, after, [1, 2, 3]);
  expect(origins).toEqual([1, null, 2, 3]);
  expect(mapSourceLines(after, "a\nnewer\nb\nc", origins)).toEqual([1, null, 2, 3]);
});

it("uses exact disjoint editor changes, including edits around identical lines", () => {
  const before = "x\nsame\nsame\nz";
  const changes = ChangeSet.of(
    [
      { from: 2, insert: "new\n" },
      { from: 7, to: 12 },
    ],
    before.length,
  );
  const after = changes.apply(Text.of(before.split("\n"))).toString();
  expect(mapBreakpointLines(before, after, [2, 3], changes)).toEqual([3]);
});

it("finds nested halt points, functions and declared methods but excludes inherited source copies", () => {
  const compiled = compileProject([
    `PROGRAM Main VAR b: Child; END_VAR\nIF TRUE THEN b(); END_IF; END_PROGRAM`,
    `FUNCTION_BLOCK Base VAR n: INT; END_VAR\nMETHOD PUBLIC Count\nn := n + 1;\nEND_METHOD\nn := 2;\nEND_FUNCTION_BLOCK`,
    `FUNCTION_BLOCK Child EXTENDS Base END_FUNCTION_BLOCK`,
    `FUNCTION Twice: INT VAR_INPUT n: INT; END_VAR\nTwice := n * 2; END_FUNCTION`,
  ]);
  expect(compiled.diagnostics).toEqual([]);
  expect(haltPoints(compiled.ir!, "Main")).toHaveLength(2);
  expect(haltPoints(compiled.ir!, "Base")).toEqual([
    { pou: "Base", line: 5 },
    { pou: "Base.Count", line: 3 },
  ]);
  expect(haltPoints(compiled.ir!, "Child")).toEqual([]);
  expect(haltPoints(compiled.ir!, "Twice")).toEqual([{ pou: "Twice", line: 2 }]);
});

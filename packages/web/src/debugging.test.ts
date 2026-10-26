import { expect, it } from "vitest";
import type { CallFrame, RuntimeSnapshot } from "@benchtop-plc/core";
import { debugShortcut, formatCallValue, frameMatchesSource, frameSnapshot } from "./debugging.js";
const key = {
  key: "n",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
};
const frame: CallFrame = {
  kind: "METHOD",
  pou: "Motion.Motor.Apply",
  instance: "Line1.DRIVE",
  span: { line: 5, column: 1, endLine: 5, endColumn: 8 },
  annotations: {
    4: [
      {
        span: { line: 4, column: 1, endLine: 4, endColumn: 8 },
        values: [{ dataType: "INT", value: 2 }],
      },
    ],
  },
  values: [],
};
it("maps four plain letter shortcuts only in a focused, halted app outside text entry", () => {
  for (const [letter, message] of [
    ["c", { type: "continue" }],
    ["n", { type: "debugStep", kind: "over" }],
    ["i", { type: "debugStep", kind: "into" }],
    ["o", { type: "debugStep", kind: "out" }],
  ] as const)
    expect(debugShortcut({ ...key, key: letter }, true, false)).toEqual(message);
  expect(debugShortcut(key, false, false)).toBeNull();
  expect(debugShortcut(key, true, true)).toBeNull();
  for (const modifier of ["ctrlKey", "altKey", "metaKey", "shiftKey", "repeat", "isComposing"])
    expect(debugShortcut({ ...key, [modifier]: true }, true, false)).toBeNull();
  expect(debugShortcut({ ...key, key: "F10" }, true, false)).toBeNull();
});
it("matches the declaring source and selected instance, including qualified method names", () => {
  expect(frameMatchesSource(frame, "Motion.Motor", "Line1.DRIVE")).toBe(true);
  expect(frameMatchesSource(frame, "Motion.Motor", "Line2.DRIVE")).toBe(false);
  expect(frameMatchesSource(frame, "Other")).toBe(false);
  expect(frameMatchesSource(undefined, "Motion.Motor")).toBe(false);
});
it("replaces stale watched values with a selected frame's own unwatched annotations", () => {
  const body = { pou: frame.pou, instance: frame.instance, scanCount: 2, lines: {} };
  const snapshot = { scanCount: 3, annotations: [body] } as RuntimeSnapshot;
  const result = frameSnapshot(snapshot, frame)!;
  expect(result.annotations).toEqual([{ ...body, scanCount: 4, lines: frame.annotations }]);
  expect(snapshot.annotations).toEqual([body]);
  expect(frameSnapshot(null, frame)).toBeNull();
  expect(frameSnapshot(snapshot, undefined)).toBe(snapshot);
});
it("formats scalar, reference and aggregate invocation values", () => {
  expect(formatCallValue({ dataType: "INT", value: 7 })).toBe("7");
  expect(formatCallValue({ kind: "reference", target: null })).toBe("NULL");
  expect(formatCallValue({ kind: "reference", target: "Line1.DRIVE" })).toBe("Line1.DRIVE");
  expect(
    formatCallValue({
      kind: "aggregate",
      elements: [{ name: "[2]", value: { dataType: "INT", value: 7 } }],
    }),
  ).toBe("[2]: 7");
});

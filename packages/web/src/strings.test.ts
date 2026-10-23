import { expect, it } from "vitest";
import { parseWrittenValue, formatMonitoredValue } from "./monitor.js";
import { readStToken, nextIndent } from "./editor/tokenizer.js";

it("accepts only complete quoted literals matching the destination width and capacity", () => {
  const type = { kind: "string", base: "STRING", length: 3 } as const;
  expect(parseWrittenValue(type, " '$4F$4B' ")).toEqual({ dataType: "STRING", value: "OK" });
  expect(parseWrittenValue("WCHAR", '"$00C4"')).toEqual({ dataType: "WCHAR", value: "Ä" });
  for (const source of [
    "123",
    "'long'",
    "'Ā'",
    "'$Q'",
    "'abc",
    "'a\nb'",
    '"OK"',
    "'OK'; x := 1;",
    "'OK' // trailing text",
  ])
    expect(parseWrittenValue(type, source), source).toBeNull();
  expect(parseWrittenValue("CHAR", "''")).toBeNull();
  expect(parseWrittenValue("CHAR", "'ab'")).toBeNull();
  expect(formatMonitoredValue(type, { dataType: "STRING", value: "123" })).toBe("'123'");
  expect(formatMonitoredValue("LINT", { dataType: "LINT", value: "123" })).toBe("123");
});

it.each(["'(* // *)'", '"(* // *)"', "CHAR#'$''", 'WSTRING#"$" //"'])(
  "highlights %s as one literal without entering comments",
  (source) => {
    const state = { commentDepth: 0 };
    expect(readStToken(source, state)).toEqual({ length: source.length, style: "string" });
    expect(state.commentDepth).toBe(0);
  },
);

it("keeps incomplete strings on one line and ignores their keywords when indenting", () => {
  const state = { commentDepth: 0 };
  expect(readStToken("'(* unfinished", state)).toEqual({ length: 14, style: "string" });
  expect(state.commentDepth).toBe(0);
  expect(nextIndent("  s := 'THEN'", "")).toBe(2);
});

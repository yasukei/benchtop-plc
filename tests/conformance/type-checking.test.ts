import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { check, parse } from "@benchtop-plc/compiler";

it("checks the milestone reference program without diagnostics", () => {
  const source = readFileSync(new URL("./fixtures/reference.st", import.meta.url), "utf8");
  const parsed = parse(source);
  expect(parsed.diagnostics).toEqual([]);
  const checked = check(parsed.ast!);
  expect(checked.diagnostics).toEqual([]);
  expect(checked.checked!.symbols).toHaveLength(11);
});

it("keeps integer division, wrapping and TIME arithmetic distinct from implicit conversions", () => {
  const parsed = parse(`PROGRAM Semantics
VAR
  truncated : INT := -7 / 2;
  wrapped : UINT := -1;
  duration : TIME := T#1s * 1.5;
  logical : BOOL := TRUE AND NOT FALSE;
  bits : INT := 16#0F AND 16#03;
END_VAR
END_PROGRAM`);
  expect(parsed.diagnostics).toEqual([]);
  const result = check(parsed.ast!);
  expect(result.diagnostics).toEqual([]);
  expect(result.checked!.symbols.map((symbol) => symbol.initialValue)).toEqual([
    -3,
    65535,
    1500,
    true,
    3,
  ]);
});

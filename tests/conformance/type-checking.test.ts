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

it("preserves LREAL literals while retaining REAL rounding and integer operator wrapping", () => {
  const parsed = parse(`PROGRAM LiteralBoundaries
VAR
  precise : LREAL := 0.1;
  large : LREAL := -1.0e100;
  rounded : REAL := 0.1;
  arithmetic : LREAL := 0.1 + 0.0;
  minimum : DINT := -2147483648;
  maximum : DINT := 2147483647;
  wrapped : DINT := 2147483647 + 1;
END_VAR
END_PROGRAM`);
  expect(parsed.diagnostics).toEqual([]);
  const result = check(parsed.ast!);
  expect(result.diagnostics).toEqual([]);
  expect(result.checked!.symbols.map((symbol) => symbol.initialValue)).toEqual([
    0.1,
    -1e100,
    Math.fround(0.1),
    Math.fround(0.1),
    -2147483648,
    2147483647,
    -2147483648,
  ]);
});

it.each(["DINT", "REAL", "LREAL"])(
  "rejects integer literal overflow before %s initialization",
  (type) => {
    const parsed = parse(`PROGRAM P\nVAR x : ${type} := 3000000000; END_VAR\nEND_PROGRAM`);
    expect(parsed.diagnostics).toEqual([]);
    const result = check(parsed.ast!);
    expect(result.checked).toBeNull();
    expect(result.diagnostics).toEqual([
      {
        code: "type.invalid-constant",
        severity: "error",
        args: {},
        span: { line: 2, column: type.length + 13, endLine: 2, endColumn: type.length + 23 },
      },
    ]);
  },
);

import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { type RuntimeSnapshot } from "@benchtop-plc/core";
import {
  createRuntime,
  RuntimeCommandRejected,
  VirtualClock,
  VirtualTicker,
} from "@benchtop-plc/runtime";

function setup(pous: string[], types: string[] = []) {
  const compiled = compileProject(pous, types);
  expect(compiled.diagnostics).toEqual([]);
  const ir = JSON.parse(JSON.stringify(compiled.ir)) as NonNullable<typeof compiled.ir>;
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  const id = (name: string) =>
    ir.variables.findIndex((v) => v.key === `MAININSTANCE.${name.toUpperCase()}`);
  const value = (snapshot: RuntimeSnapshot, name: string) => snapshot.variables[id(name)];
  return { runtime, ir, id, value };
}

it("traces string assignment, runtime truncation and code-unit comparisons", () => {
  const { runtime, value } = setup([
    `PROGRAM Main
    VAR s : STRING; msg : STRING[5]; wide : WSTRING; escaped, ordered, wideEqual, prefixFirst : BOOL; END_VAR
    s := 'Hello world'; msg := s; wide := "$00C4";
    escaped := '$41' = 'A'; ordered := 'abc' < 'abd'; wideEqual := wide = "Ä";
    prefixFirst := 'a' < 'aa'; END_PROGRAM`,
  ]);
  const trace = [runtime.snapshot(), runtime.step(), runtime.step()].map((snapshot) =>
    value(snapshot, "msg"),
  );
  expect(trace).toEqual(
    ["", "Hello", "Hello"].map((value) => ({ kind: "scalar", dataType: "STRING", value })),
  );
  for (const name of ["escaped", "ordered", "wideEqual", "prefixFirst"])
    expect(value(runtime.snapshot(), name)).toEqual({
      kind: "scalar",
      dataType: "BOOL",
      value: true,
    });
  expect(runtime.diagnostic).toBeNull();
  expect(
    Object.values(runtime.snapshot().annotations.Main ?? {})
      .flat()
      .flatMap((a) => a.values),
  ).toContainEqual({ dataType: "STRING", value: "Hello" });
});

it("uses the common character type for selection, ordering and MOVE", () => {
  const { runtime, value } = setup([
    `PROGRAM Main
    VAR ch : CHAR := 'B'; wch : WCHAR := "Ä"; s : STRING := 'abc'; wide : WSTRING := "Ω";
      selected, multiplexed, largest, smallest, limited, moved : STRING; wideSelected : WSTRING; character : CHAR; comparison : BOOL;
    END_VAR
    selected := SEL(FALSE, ch, s); multiplexed := MUX(1, ch, s);
    largest := MAX(ch, s); smallest := MIN(s, ch); limited := LIMIT(ch, s, 'z'); moved := MOVE(ch);
    wideSelected := SEL(TRUE, wch, wide); character := SEL(TRUE, CHAR#'A', CHAR#'B'); comparison := LT(ch, s, 'z'); END_PROGRAM`,
  ]);
  const snapshot = runtime.step();
  for (const [name, expected] of Object.entries({
    selected: "B",
    multiplexed: "abc",
    largest: "abc",
    smallest: "B",
    limited: "abc",
    moved: "B",
  }))
    expect(value(snapshot, name)).toEqual({ kind: "scalar", dataType: "STRING", value: expected });
  expect(value(snapshot, "wideSelected")).toMatchObject({ dataType: "WSTRING", value: "Ω" });
  expect(value(snapshot, "character")).toMatchObject({ dataType: "CHAR", value: "B" });
  expect(value(snapshot, "comparison")).toMatchObject({ value: true });
  expect(runtime.diagnostic).toBeNull();
});

it.each([
  ["CHAR", "STRING", "'"],
  ["WCHAR", "WSTRING", '"'],
])(
  "widens %s beside untyped literals in operands and generic arguments",
  (character, string, quote) => {
    const literal = (text: string) => `${quote}${text}${quote}`;
    const { runtime, value } = setup([
      `PROGRAM Main
    VAR ch : ${character} := ${literal("A")};
      equal, reversed, ordered : BOOL;
      first, second, multiplexed, largest, smallest, limited : ${string};
    END_VAR
    equal := ch = ${literal("AB")}; reversed := (${literal("AB")}) <> ch;
    ordered := LT(ch, ${literal("AB")}, ${literal("abc")});
    first := SEL(FALSE, ch, ${literal("abc")});
    second := SEL(TRUE, ch, (${literal("abc")}));
    multiplexed := MUX(1, ch, ${literal("abc")});
    largest := MAX(ch, ${literal("abc")}); smallest := MIN(${literal("abc")}, ch);
    limited := LIMIT(ch, ${literal("abc")}, ${literal("z")});
    END_PROGRAM`,
    ]);
    const snapshot = runtime.step();
    for (const [name, expected] of Object.entries({ equal: false, reversed: true, ordered: true }))
      expect(value(snapshot, name)).toMatchObject({ dataType: "BOOL", value: expected });
    for (const [name, expected] of Object.entries({
      first: "A",
      second: "abc",
      multiplexed: "abc",
      largest: "abc",
      smallest: "A",
      limited: "abc",
    }))
      expect(value(snapshot, name)).toMatchObject({ dataType: string, value: expected });
    expect(runtime.diagnostic).toBeNull();
  },
);

it("truncates inputs, outputs, results and in-outs at the actual storage capacity", () => {
  const { runtime, value } = setup([
    `PROGRAM Main VAR text : STRING := 'abcdef'; shortText : STRING[2]; resultText : STRING[3]; outputText : STRING[1]; unit : EchoBlock; END_VAR
      resultText := Echo(input := text, output => outputText, current := shortText);
      unit(input := text, output => outputText, current := shortText); END_PROGRAM`,
    `FUNCTION Echo : STRING[4] VAR_INPUT input : STRING[5]; END_VAR VAR_OUTPUT output : STRING[3]; END_VAR VAR_IN_OUT current : STRING[80]; END_VAR
      current := input; output := input; Echo := input; END_FUNCTION`,
    `FUNCTION_BLOCK EchoBlock VAR_INPUT input : STRING[4]; END_VAR VAR_OUTPUT output : STRING[3]; END_VAR VAR_IN_OUT current : STRING[10]; END_VAR
      current := input; output := input; END_FUNCTION_BLOCK`,
  ]);
  const snapshot = runtime.step();
  for (const [name, expected] of Object.entries({
    shortText: "ab",
    resultText: "abc",
    outputText: "a",
    "unit.input": "abcd",
    "unit.output": "abc",
  }))
    expect(value(snapshot, name)).toMatchObject({ dataType: "STRING", value: expected });
  expect(runtime.diagnostic).toBeNull();
});

it("keeps decimal text separate from 64-bit values across snapshots, writes and forces", () => {
  const { runtime, value, id } = setup([
    `PROGRAM Main VAR numberValue : LINT := 123; text : STRING[3] := '123'; mirrored : STRING[3]; same : BOOL; END_VAR
    mirrored := text; same := numberValue = LINT#123; END_PROGRAM`,
  ]);
  const initial = runtime.step();
  expect(value(initial, "numberValue")).toEqual({ kind: "scalar", dataType: "LINT", value: "123" });
  expect(value(initial, "text")).toEqual({ kind: "scalar", dataType: "STRING", value: "123" });
  runtime.write(id("text"), { dataType: "STRING", value: "OK" });
  runtime.write(id("numberValue"), { dataType: "LINT", value: "456" });
  expect(value(runtime.step(), "mirrored")).toMatchObject({ value: "OK" });
  runtime.force(id("text"), { dataType: "STRING", value: "123" });
  runtime.force(id("numberValue"), { dataType: "LINT", value: "123" });
  for (const invalid of [
    { dataType: "STRING", value: "long" },
    { dataType: "STRING", value: "Ā" },
    { dataType: "LINT", value: "123" },
  ] as const) {
    expect(() => runtime.write(id("text"), invalid)).toThrow(RuntimeCommandRejected);
    expect(() => runtime.force(id("text"), invalid)).toThrow(RuntimeCommandRejected);
  }
  const snapshot = runtime.step();
  expect(value(snapshot, "mirrored")).toMatchObject({ dataType: "STRING", value: "123" });
  expect(value(snapshot, "numberValue")).toMatchObject({ dataType: "LINT", value: "123" });
  expect(snapshot.forced).toEqual([id("numberValue"), id("text")]);
});

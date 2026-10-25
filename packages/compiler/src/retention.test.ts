import { expect, it } from "vitest";
import { compileProject } from "./index.js";

it.each([
  ["VAR RETAIN NON_RETAIN", "decl.retention-conflict"],
  ["VAR_TEMP RETAIN", "decl.retention-section"],
  ["VAR_IN_OUT NON_RETAIN", "decl.retention-section"],
  ["VAR_EXTERNAL RETAIN", "decl.retention-section"],
  ["VAR RETAIN CONSTANT", "decl.retention-constant"],
  ["VAR CONSTANT NON_RETAIN", "decl.retention-constant"],
])("rejects %s with a retention diagnostic", (section, code) => {
  const result = compileProject([
    `FUNCTION_BLOCK B ${section} x : INT; END_VAR END_FUNCTION_BLOCK`,
    "PROGRAM P END_PROGRAM",
  ]);
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
});

it.each(["RETAIN", "NON_RETAIN"])(
  "rejects %s in functions, located declarations and address connections",
  (qualifier) => {
    for (const [sources, config, code] of [
      [
        [
          `FUNCTION F : INT VAR ${qualifier} x : INT; END_VAR END_FUNCTION`,
          "PROGRAM P END_PROGRAM",
        ],
        undefined,
        "decl.retention-function",
      ],
      [
        [`PROGRAM P VAR ${qualifier} x AT %IX0.0 : BOOL; END_VAR END_PROGRAM`],
        undefined,
        "decl.retention-address",
      ],
      [
        [`PROGRAM P VAR_INPUT ${qualifier} x : BOOL; END_VAR END_PROGRAM`],
        `CONFIGURATION C RESOURCE R ON Cpu TASK T (INTERVAL := T#10ms, PRIORITY := 0); PROGRAM A WITH T : P (x := %IX0.0); END_RESOURCE END_CONFIGURATION`,
        "decl.retention-address",
      ],
      [
        [`PROGRAM P VAR_OUTPUT ${qualifier} x : BOOL; END_VAR END_PROGRAM`],
        `CONFIGURATION C RESOURCE R ON Cpu TASK T (INTERVAL := T#10ms, PRIORITY := 0); PROGRAM A WITH T : P (x => %QX0.0); END_RESOURCE END_CONFIGURATION`,
        "decl.retention-address",
      ],
    ] as const) {
      const result = compileProject(sources, [], config);
      expect(result.ir).toBeUndefined();
      expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
    }
  },
);

it.each(["RETAIN NON_RETAIN", "NON_RETAIN CONSTANT"])(
  "rejects conflicting global qualifiers %s",
  (qualifiers) => {
    const result = compileProject(
      ["PROGRAM P END_PROGRAM"],
      [],
      `CONFIGURATION C VAR_GLOBAL ${qualifiers} x : INT; END_VAR RESOURCE R ON Cpu TASK T (INTERVAL := T#10ms, PRIORITY := 0); PROGRAM A WITH T : P; END_RESOURCE END_CONFIGURATION`,
    );
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.some((d) => d.code.startsWith("decl.retention-"))).toBe(true);
  },
);

it("passes qualifiers through user blocks, structures and arrays while respecting member overrides", () => {
  const result = compileProject(
    [
      `FUNCTION_BLOCK Inner VAR inherited : INT; END_VAR VAR RETAIN kept : INT; END_VAR VAR NON_RETAIN reset : INT; END_VAR END_FUNCTION_BLOCK`,
      `PROGRAM P VAR RETAIN a : Inner; items : ARRAY[1..2] OF Inner; data : Pair; END_VAR VAR NON_RETAIN b : Inner; END_VAR VAR_INPUT RETAIN input : INT; END_VAR VAR_OUTPUT NON_RETAIN output : INT; END_VAR END_PROGRAM`,
    ],
    ["TYPE Pair : STRUCT x : INT; y : ARRAY[0..1] OF INT; END_STRUCT; END_TYPE"],
  );
  expect(result.diagnostics).toEqual([]);
  expect(
    Object.fromEntries(result.ir!.variables.map((v) => [v.name.toUpperCase(), v.retain])),
  ).toEqual({
    "MAININSTANCE.A.INHERITED": true,
    "MAININSTANCE.A.KEPT": true,
    "MAININSTANCE.A.RESET": false,
    "MAININSTANCE.ITEMS[1].INHERITED": true,
    "MAININSTANCE.ITEMS[1].KEPT": true,
    "MAININSTANCE.ITEMS[1].RESET": false,
    "MAININSTANCE.ITEMS[2].INHERITED": true,
    "MAININSTANCE.ITEMS[2].KEPT": true,
    "MAININSTANCE.ITEMS[2].RESET": false,
    "MAININSTANCE.DATA.X": true,
    "MAININSTANCE.DATA.Y[0]": true,
    "MAININSTANCE.DATA.Y[1]": true,
    "MAININSTANCE.B.INHERITED": false,
    "MAININSTANCE.B.KEPT": true,
    "MAININSTANCE.B.RESET": false,
    "MAININSTANCE.INPUT": true,
    "MAININSTANCE.OUTPUT": false,
  });
});

it("accepts retained globals and retained parameters connected to globals and constants", () => {
  const result = compileProject(
    ["PROGRAM P VAR_INPUT RETAIN x : INT; END_VAR VAR_OUTPUT RETAIN y : INT; END_VAR END_PROGRAM"],
    [],
    `CONFIGURATION C VAR_GLOBAL RETAIN g : INT; END_VAR RESOURCE R ON Cpu VAR_GLOBAL NON_RETAIN n : INT; END_VAR TASK T (INTERVAL := T#10ms, PRIORITY := 0); PROGRAM A WITH T : P (x := 2, y => g); PROGRAM B WITH T : P (x := g, y => n); END_RESOURCE END_CONFIGURATION`,
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.ir!.variables[0]).toMatchObject({ name: "g", retain: true });
  expect(result.ir!.variables[1]).toMatchObject({ name: "n", retain: false });
});

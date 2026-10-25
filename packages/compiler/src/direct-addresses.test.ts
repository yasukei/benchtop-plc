import { expect, it } from "vitest";
import { addressTypes, areaBytes, addressBytes } from "@benchtop-plc/core";
import { compile, compileProject, lex } from "./index.js";

for (const area of ["I", "Q", "M"] as const)
  for (const [size, types] of Object.entries(addressTypes))
    for (const type of types)
      it(`binds ${type} to %${area}${size} at the area boundary`, () => {
        const last = areaBytes[area] / addressBytes[size as keyof typeof addressBytes] - 1;
        const address = size === "X" ? `%${area}X${last}.7` : `%${area}${size}${last}`;
        const result = compile(`PROGRAM Main VAR v AT ${address} : ${type}; END_VAR END_PROGRAM`);
        expect(result.diagnostics).toEqual([]);
        expect(result.ir?.variables[0]).toMatchObject({ address: { area, size } });
        expect(
          compile(
            `PROGRAM Main VAR v AT %${area}${size}${size === "X" ? `${last + 1}.0` : last + 1} : ${type}; END_VAR END_PROGRAM`,
          ).diagnostics,
        ).toContainEqual(expect.objectContaining({ code: "decl.address-out-of-range" }));
      });

it.each([
  ["%IW0", "BOOL"],
  ["%IX0.0", "INT"],
  ["%IB0", "WORD"],
  ["%IW0", "DWORD"],
  ["%ID0", "LREAL"],
  ["%IL0", "REAL"],
  ["%MD0", "TIME"],
  ["%MW0", "DATE"],
  ["%MB0", "CHAR"],
  ["%MB0", "STRING"],
  ["%MW0", "INT(0..10)"],
  ["%MW0", "ARRAY[1..2] OF INT"],
  ["%QX0.0", "TON"],
])("rejects %s bound to %s", (address, type) => {
  expect(
    compile(`PROGRAM Main VAR v AT ${address} : ${type}; END_VAR END_PROGRAM`).diagnostics,
  ).toContainEqual(expect.objectContaining({ code: "decl.direct-address-type" }));
});
it.each(["%IX1.2.3", "%I*", "%MW*", "%MX1", "%IW0.0"])(
  "rejects unsupported address %s",
  (address) => {
    expect(lex(address).diagnostics).toContainEqual(
      expect.objectContaining({ code: "lex.malformed-direct-address" }),
    );
  },
);
it.each(["%QB999999", "%IX64.0", "%MX1024.0", "%IX0.8"])("rejects out-of-area %s", (address) => {
  const type = address.includes("B") ? "BYTE" : "BOOL";
  expect(
    compile(`PROGRAM Main VAR v AT ${address} : ${type}; END_VAR END_PROGRAM`).diagnostics,
  ).toContainEqual(expect.objectContaining({ code: "decl.address-out-of-range" }));
});
it("accepts aliases but rejects enumerations at direct addresses", () => {
  expect(
    compileProject(
      ["PROGRAM Main VAR v AT %MW0 : Sample; END_VAR END_PROGRAM"],
      ["TYPE Sample : INT; END_TYPE"],
    ).diagnostics,
  ).toEqual([]);
  expect(
    compileProject(
      ["PROGRAM Main VAR v AT %MW0 : Mode; END_VAR END_PROGRAM"],
      ["TYPE Mode : (Disabled, Enabled); END_TYPE"],
    ).diagnostics,
  ).toContainEqual(expect.objectContaining({ code: "decl.direct-address-type" }));
});
it.each([
  ["PROGRAM Main VAR_TEMP v AT %MW0 : INT; END_VAR END_PROGRAM", "decl.temp-address"],
  ["PROGRAM Main VAR_INPUT v AT %IW0 : INT; END_VAR END_PROGRAM", "decl.parameter-address"],
  ["PROGRAM Main VAR_OUTPUT v AT %QW0 : INT; END_VAR END_PROGRAM", "decl.parameter-address"],
  ["PROGRAM Main VAR CONSTANT v AT %MW0 : INT := 1; END_VAR END_PROGRAM", "decl.constant-address"],
  ["FUNCTION_BLOCK Main VAR v AT %MW0 : INT; END_VAR END_FUNCTION_BLOCK", "pou.direct-address"],
  ["FUNCTION Main : INT VAR v AT %MW0 : INT; END_VAR END_FUNCTION", "pou.direct-address"],
])("rejects AT in restricted declarations: %s", (source, code) => {
  expect(compile(source).diagnostics).toContainEqual(expect.objectContaining({ code }));
});
it("warns on output overlaps, including bit/word and connection writers", () => {
  const result = compileProject(
    [
      "PROGRAM Main VAR a AT %QW0 : WORD; b AT %QX1.7 : BOOL; END_VAR VAR_OUTPUT out : BYTE; END_VAR END_PROGRAM",
    ],
    [],
    `CONFIGURATION Plant RESOURCE Station ON Cpu TASK T (INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM A WITH T : Main (out => %QB0); END_RESOURCE END_CONFIGURATION`,
  );
  expect(result.ir).toBeDefined();
  expect(result.diagnostics.map((d) => [d.code, d.severity])).toEqual([
    ["decl.output-overlap", "warning"],
    ["decl.output-overlap", "warning"],
  ]);
});
it("does not warn for independent output bits/words or input and memory aliases", () => {
  const result = compile(`PROGRAM Main VAR
    a AT %QX0.0 : BOOL; b AT %QX0.1 : BOOL;
    c AT %QW1 : WORD; d AT %QW2 : INT;
    e AT %IW0 : INT; f AT %IX0.0 : BOOL;
    g AT %MW0 : INT; h AT %MB0 : BYTE;
    END_VAR END_PROGRAM`);
  expect(result.diagnostics).toEqual([]);
});
it("checks typed connections and globals with the same address rules", () => {
  const program =
    "PROGRAM Main VAR_INPUT n : INT; END_VAR VAR_OUTPUT out : LREAL; END_VAR END_PROGRAM";
  for (const [connection, code] of [
    ["n := %IW31, out => %ML127", null],
    ["n := %IB0", "decl.direct-address-type"],
    ["n := %IW32", "decl.address-out-of-range"],
    ["out => %IL0", "config.connection-target"],
  ] as const) {
    const result = compileProject(
      [program],
      [],
      `CONFIGURATION Plant
      VAR_GLOBAL g AT %MD255 : REAL; END_VAR RESOURCE Station ON Cpu
      TASK T (INTERVAL := T#10ms, PRIORITY := 1); PROGRAM A WITH T : Main (${connection});
      END_RESOURCE END_CONFIGURATION`,
    );
    if (code) expect(result.diagnostics).toContainEqual(expect.objectContaining({ code }));
    else expect(result.diagnostics).toEqual([]);
  }
});

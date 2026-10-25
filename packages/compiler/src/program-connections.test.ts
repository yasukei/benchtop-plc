import { expect, it } from "vitest";
import { compileProject } from "./index.js";

const program = `PROGRAM Main VAR_INPUT Start : BOOL; Threshold : INT; END_VAR
VAR_OUTPUT Lamp : BOOL; Count : INT; END_VAR VAR local : BOOL; END_VAR END_PROGRAM`;
const configuration = (connections: string) => `CONFIGURATION Plant
VAR_GLOBAL g : BOOL; n : DINT; input AT %IX0.0 : BOOL; END_VAR
VAR_GLOBAL CONSTANT c : BOOL := TRUE; END_VAR
RESOURCE Station ON Cpu TASK T (INTERVAL := T#10ms, PRIORITY := 1);
PROGRAM A WITH T : Main (${connections}); END_RESOURCE END_CONFIGURATION`;

it.each([
  ["Missing := TRUE", "config.connection-parameter"],
  ["local := TRUE", "config.connection-parameter"],
  ["Start => g", "config.connection-direction"],
  ["Lamp := g", "config.connection-direction"],
  ["Start := TRUE, start := FALSE", "config.connection-duplicate"],
  ["Start := n", "type.assign-mismatch"],
  ["Threshold := n", "type.assign-mismatch"],
  ["Lamp => TRUE", "config.connection-target"],
  ["Lamp => c", "config.connection-target"],
  ["Lamp => %IX0.0", "config.connection-target"],
  ["Lamp => input", "config.connection-target"],
  ["Start := n > 0", "config.connection-target"],
  ["Start := %IX1.0", "decl.address-out-of-range"],
  ["Threshold := %IX0.0", "decl.direct-address-type"],
])("rejects %s in the configuration source", (connections, code) => {
  const result = compileProject([program], [], configuration(connections));
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({ code, sourceKind: "configuration", sourceIndex: 0, pou: "Plant" }),
  );
});

it("accepts constants, widening and case-insensitive parameter names", () => {
  const result = compileProject(
    [program],
    [],
    configuration("sTaRt := c, Threshold := 1 + 2, Count => n, Lamp => %QX0.0"),
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.ir!.resource.programs[0]!.inputs).toHaveLength(2);
});

it("accepts unconnected inputs and outputs under the implicit configuration", () => {
  expect(compileProject([program]).diagnostics).toEqual([]);
  expect(
    compileProject(["PROGRAM P VAR_IN_OUT x : INT; END_VAR END_PROGRAM"]).diagnostics,
  ).toContainEqual(expect.objectContaining({ code: "pou.invalid-section" }));
});

it("connects contextual enumeration literals and aliases to BOOL addresses", () => {
  const result = compileProject(
    ["PROGRAM P VAR_INPUT selectedMode : Mode; flag : FlagType; END_VAR END_PROGRAM"],
    ["TYPE Mode : (Idle, Active); END_TYPE", "TYPE FlagType : BOOL; END_TYPE"],
    `CONFIGURATION Plant RESOURCE Station ON Cpu TASK T (INTERVAL := T#10ms, PRIORITY := 1);
  PROGRAM A WITH T : P (selectedMode := Mode#Active, flag := %IX0.0);
  PROGRAM B WITH T : P (selectedMode := Idle); END_RESOURCE END_CONFIGURATION`,
  );
  expect(result.diagnostics).toEqual([]);
  expect(result.ir!.resource.programs[0]!.inputs![0]!.endpoint).toEqual({
    kind: "constant",
    value: 1,
  });
  expect(result.ir!.resource.programs[1]!.inputs![0]!.endpoint).toEqual({
    kind: "constant",
    value: 0,
  });
});

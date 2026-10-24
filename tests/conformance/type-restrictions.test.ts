import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";

it("rejects unsupported value types while preserving recursive references", () => {
  const main = "PROGRAM Main END_PROGRAM";
  const invalid = compileProject(
    [main],
    ["TYPE Node : STRUCT next : ARRAY[1..2] OF Node; END_STRUCT; END_TYPE"],
  );
  expect(invalid.ir).toBeUndefined();
  expect(invalid.diagnostics).toEqual([
    expect.objectContaining({ code: "decl.type-cycle", args: { name: "Node" } }),
  ]);
  const valid = compileProject(
    ["PROGRAM Main VAR nodeValue : Node; END_VAR END_PROGRAM"],
    ["TYPE Node : STRUCT next : REF_TO Node; v : INT; END_STRUCT; END_TYPE"],
  );
  expect(valid.diagnostics).toEqual([]);
  expect(valid.ir).toBeDefined();
  const block = compileProject(
    [main],
    ["TYPE S : STRUCT timers : ARRAY[1..2] OF ARRAY[1..3] OF TON; END_STRUCT; END_TYPE"],
  );
  expect(block.ir).toBeUndefined();
  expect(block.diagnostics).toEqual([
    expect.objectContaining({ code: "decl.structure-member-type", args: { name: "TON" } }),
  ]);
});

it("requires an unrestricted integer FOR variable even when the bounds fit a subrange", () => {
  const result = compileProject(
    ["PROGRAM Main VAR p : Percent; END_VAR FOR p := 0 TO 10 DO END_FOR; END_PROGRAM"],
    ["TYPE Percent : INT (0..100); END_TYPE"],
  );
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toEqual([
    expect.objectContaining({
      code: "type.for-variable-subrange",
      args: { name: "p", type: { kind: "named", name: "Percent" } },
    }),
  ]);
});

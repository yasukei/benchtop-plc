import { expect, it } from "vitest";
import { blockTypeAt } from "./block-hover.js";

it("shows selected variants on declarations and uses, excluding comments and member names", () => {
  const source = `PROGRAM Main VAR c: CTU; END_VAR
    // c is a counter
    c(PV := DINT#40000); END_PROGRAM`;
  for (const position of [source.indexOf("c:"), source.indexOf("c(PV")])
    expect(blockTypeAt([source], 0, position)).toMatchObject({
      text: "c: CTU_DINT",
      from: position,
      to: position + 1,
    });
  expect(blockTypeAt([source], 0, source.indexOf("c is"))).toBeNull();
  expect(blockTypeAt([source], 0, source.indexOf("PV"))).toBeNull();
});

it("resolves in uninstantiated user blocks and refreshes after editing the binding", () => {
  const main = "PROGRAM Main END_PROGRAM";
  const block = "FUNCTION_BLOCK Block VAR c: CTU; END_VAR c(PV := ULINT#1); END_FUNCTION_BLOCK";
  expect(blockTypeAt([main, block], 1, block.indexOf("c:"))?.text).toBe("c: CTU_ULINT");
  const changed = block.replace("ULINT#1", "DINT#1");
  expect(blockTypeAt([main, changed], 1, changed.indexOf("c:"))?.text).toBe("c: CTU_DINT");
  expect(
    blockTypeAt([main, block.replace("ULINT#1", "100000")], 1, block.indexOf("c:")),
  ).toBeNull();
});

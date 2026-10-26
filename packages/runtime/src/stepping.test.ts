import { expect, it } from "vitest";
import { stepReached } from "./stepping.js";

it("distinguishes sibling calls at the same depth from the original frame", () => {
  const program = {},
    callee = {},
    sibling = {};
  const origin = [program, callee];
  for (const kind of ["over", "out"] as const) {
    expect(stepReached({ kind, origin }, [program, sibling])).toBe(false);
    expect(stepReached({ kind, origin }, [program])).toBe(true);
    expect(stepReached({ kind, origin }, [{}])).toBe(true);
  }
  expect(stepReached({ kind: "over", origin }, origin)).toBe(true);
  expect(stepReached({ kind: "out", origin }, origin)).toBe(false);
  expect(stepReached({ kind: "into", origin }, [program, sibling])).toBe(true);
});

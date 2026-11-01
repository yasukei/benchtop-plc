import { expect, it, vi } from "vitest";
import type { Expression, Statement } from "@benchtop-plc/core";
import { lower } from "./lowering.js";

const span = { line: 1, column: 1, endLine: 1, endColumn: 10 };

it.each([false, true])("analyzes each subtree once with user calls=%s", (withCall) => {
  let value: Expression = withCall
    ? {
        kind: "userFunctionCall",
        function: 0,
        inputs: [],
        outputs: [],
        dataType: "INT",
        span,
      }
    : { kind: "literal", dataType: "INT", value: 1, span };
  const expressions: Expression[] = [value];
  for (let index = 0; index < 200; index++) {
    value = {
      kind: "binary",
      operator: "+",
      left: { kind: "literal", dataType: "INT", value: 1, span },
      right: value,
      dataType: "INT",
      span,
    };
    expressions.push(value.left, value);
  }
  const statement: Statement = {
    kind: "assignment",
    target: { kind: "variable", variable: 0, dataType: "INT", span },
    value,
    span,
  };
  const entries = vi.spyOn(Object, "entries");
  try {
    lower([statement]);
    // A separate body can reuse subtrees; negative results must be cached too.
    lower([{ ...statement }]);
    const counts = new Map<object, number>();
    for (const [object] of entries.mock.calls) counts.set(object, (counts.get(object) ?? 0) + 1);
    for (const expression of expressions)
      expect(counts.get(expression) ?? 0).toBe(expression.kind === "userFunctionCall" ? 0 : 1);
  } finally {
    entries.mockRestore();
  }
});

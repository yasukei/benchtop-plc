import { describe, expect, it } from "vitest";
import type { Expression, ProgramIR } from "@benchtop-plc/core";
import { Interpreter } from "./interpreter.js";
import { Memory } from "./memory.js";

const span = { line: 1, column: 1, endLine: 1, endColumn: 10 };
const ir: ProgramIR = { kind: "program", name: "Test", variables: [], body: [], span };

describe("MOD expressions", () => {
  it.each([
    ["INT", 7, 0, 0],
    ["INT", -7, 0, 0],
    ["INT", 0, 0, 0],
    ["DINT", 40000, 0, 0],
    ["DINT", -40000, 0, 0],
    ["UINT", 7, 0, 0],
    ["INT", -7, 2, -1],
    ["INT", 7, -2, 1],
  ] as const)("evaluates %s %s MOD %s to %s", (dataType, left, right, expected) => {
    const expression: Expression = {
      kind: "binary",
      operator: "MOD",
      left: { kind: "literal", dataType, value: left, span },
      right: { kind: "literal", dataType, value: right, span },
      dataType,
      span,
    };
    const interpreter = new Interpreter(new Memory(ir), 0, () => true);
    expect(interpreter.expression(expression)).toBe(expected);
  });
});

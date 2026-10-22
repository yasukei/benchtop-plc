import { expect, it, vi } from "vitest";
import * as core from "@benchtop-plc/core";
import type { ProgramIR } from "@benchtop-plc/core";
import { Interpreter } from "./interpreter.js";
import { Memory } from "./memory.js";

const span = { line: 1, column: 1, endLine: 1, endColumn: 2 };
function program(): ProgramIR {
  return {
    kind: "program",
    name: "Main",
    variables: [],
    span,
    body: [
      {
        kind: "call",
        span,
        call: {
          kind: "userFunctionCall",
          function: 0,
          inputs: [],
          outputs: [],
          dataType: null,
          span,
        },
      },
    ],
    functions: [
      {
        name: "F",
        span,
        inputs: [],
        outputs: [],
        variables: [
          { kind: "scalar", name: "n", key: "N", dataType: "INT", initialValue: 4, span },
          { kind: "scalar", name: "b", key: "B", dataType: "BOOL", initialValue: true, span },
          {
            kind: "scalar",
            name: "large",
            key: "LARGE",
            dataType: "LINT",
            initialValue: "9007199254740993",
            span,
          },
        ],
        body: [
          {
            kind: "if",
            span,
            branches: [
              {
                span,
                condition: { kind: "literal", dataType: "BOOL", value: false, span },
                body: [
                  {
                    kind: "assignment",
                    span,
                    target: { kind: "variable", variable: 2, dataType: "LINT", span },
                    value: { kind: "literal", dataType: "LINT", value: "1", span },
                  },
                ],
              },
            ],
            elseBody: [],
          },
        ],
      },
    ],
  };
}

it("keeps each function frame independent of other calls and their initial template", () => {
  const memory = new Memory(program());
  const first = memory.functionFrame(0),
    second = memory.functionFrame(0);
  first.write(0, 10);
  first.write(1, false);
  first.write(2, 20n);
  expect([second.read(0), second.read(1), second.read(2)]).toEqual([4, true, 9007199254740993n]);
  second.write(0, 99);
  const next = memory.functionFrame(0);
  expect([next.read(0), next.read(1), next.read(2)]).toEqual([4, true, 9007199254740993n]);
  expect([first.read(0), first.read(1), first.read(2)]).toEqual([10, false, 20n]);
});

it("validates function bodies and initial values at load without repeating checks on calls", () => {
  const validation = vi.spyOn(core, "validateValue");
  try {
    const ir = program();
    const memory = new Memory(ir);
    expect(validation).toHaveBeenCalledWith("LINT", "1");
    expect(validation).toHaveBeenCalledWith("LINT", "9007199254740993");
    const loadChecks = validation.mock.calls.length;
    const interpreter = new Interpreter(memory, 0, () => true);
    for (let call = 0; call < 100; call++) interpreter.execute(ir.body);
    expect(validation).toHaveBeenCalledTimes(loadChecks);
  } finally {
    validation.mockRestore();
  }
});

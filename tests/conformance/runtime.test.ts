import { describe, expect, it } from "vitest";
import type {
  BinaryOperator,
  DataType,
  Expression,
  ProgramIR,
  ScalarValue,
  Statement,
  Variable,
  VariableReference,
  RuntimeSnapshot,
} from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker, WATCHDOG_LIMIT } from "@benchtop-plc/runtime";
import type { RuntimeLibrary, RuntimeOptions } from "@benchtop-plc/runtime";

const span = { line: 1, column: 1, endLine: 1, endColumn: 10 };
const at = (line: number, column = 1) => ({
  ...span,
  line,
  endLine: line,
  column,
  endColumn: column + 5,
});
function literal(
  value: ScalarValue,
  dataType: DataType = typeof value === "boolean" ? "BOOL" : "INT",
): Expression {
  return { kind: "literal", dataType, value, span } as Expression;
}
function ref(variable: number, dataType: DataType = "INT"): VariableReference {
  return { kind: "variable", variable, dataType, span };
}
function scalar(
  name: string,
  dataType: DataType = "INT",
  initialValue: ScalarValue = dataType === "BOOL" ? false : 0,
): Variable {
  return {
    kind: "scalar",
    name,
    key: name.toUpperCase(),
    dataType,
    initialValue,
    span,
  } as Variable;
}
function assign(
  variable: number,
  value: Expression,
  line = 1,
  dataType: DataType = "INT",
): Statement {
  return { kind: "assignment", target: ref(variable, dataType), value, span: at(line) };
}
function binary(
  operator: BinaryOperator,
  left: Expression,
  right: Expression,
  dataType: DataType = "INT",
): Expression {
  return { kind: "binary", operator, left, right, dataType, span: at(8) };
}
function program(body: Statement[], variables: Variable[] = [scalar("n"), scalar("i")]): ProgramIR {
  return { kind: "program", name: "Test", variables, body, span };
}
function setup(ir: ProgramIR, options: Partial<RuntimeOptions> = {}) {
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock), ...options });
  runtime.load(ir);
  return { runtime, clock };
}
function value(snapshot: RuntimeSnapshot, index = 0) {
  const variable = snapshot.variables[index];
  if (variable?.kind !== "scalar") throw new Error("Expected scalar");
  return variable.value;
}
const increment = (variable = 0, line = 2) =>
  assign(variable, binary("+", ref(variable), literal(1)), line);
const output = {
  ...scalar("q", "BOOL", false),
  address: { area: "Q", byte: 0, bit: 0 },
} as Variable;

describe("runtime scans over hand-written IR", () => {
  it("runs only due scans, is idempotent, stops outputs and cancels stale ticks", () => {
    const { runtime, clock } = setup(
      program([increment(), assign(1, literal(true), 3, "BOOL")], [scalar("n"), output]),
    );
    expect(runtime.state).toBe("STOP");
    runtime.run();
    runtime.run();
    clock.advance(9);
    expect(runtime.snapshot().scanCount).toBe(0);
    clock.advance(21);
    expect(value(runtime.snapshot())).toBe(3);
    expect(runtime.snapshot().outputs[0]).toBe(true);
    runtime.stop();
    expect(runtime.state).toBe("STOP");
    expect(runtime.snapshot().outputs.every((bit) => !bit)).toBe(true);
    expect(value(runtime.snapshot(), 1)).toBe(false);
    clock.advance(100);
    expect(runtime.snapshot().scanCount).toBe(3);
    runtime.run();
    clock.advance(10);
    expect(runtime.snapshot().scanCount).toBe(4);
  });

  it("preserves scan order and applies forces both before and after execution", () => {
    const order: string[] = [];
    const input = {
      ...scalar("input", "BOOL", false),
      address: { area: "I", byte: 0, bit: 0 },
    } as Variable;
    const { runtime, clock } = setup(
      program(
        [assign(1, literal(false), 2, "BOOL"), assign(2, ref(0, "BOOL"), 3, "BOOL")],
        [input, output, scalar("seen", "BOOL", false)],
      ),
      {
        stages: {
          readInputs: () => {
            order.push("read");
            return [true, false, false, false, false, false, false, false];
          },
          applyPendingWrites: (memory) => {
            order.push("writes");
            expect(memory.read(0)).toBe(true);
            memory.write(0, false);
          },
          applyForces: (memory) => {
            order.push("forces");
            expect(memory.read(1)).toBe(false);
            memory.write(1, true);
            memory.write(0, true);
          },
          writeOutputs: (outputs) => {
            if (outputs[0]) {
              order.push("output");
              expect(outputs[0]).toBe(true);
            }
          },
        },
      },
    );
    runtime.run();
    clock.advance(10);
    expect(order).toEqual(["read", "writes", "forces", "forces", "output"]);
    expect(value(runtime.snapshot(), 2)).toBe(true);
    expect(runtime.snapshot().annotations[2]?.[0]?.values[0]?.value).toBe(false);
  });

  it.each([
    ["INT", 32768, -32768],
    ["UINT", -1, 65535],
    ["DINT", 2147483648, -2147483648],
    ["REAL", 0.1, Math.fround(0.1)],
    ["LREAL", 0.1, 0.1],
    ["TIME", 1.8, 1],
    ["BOOL", 1, true],
  ] as const)("coerces %s assignments", (type, input, expected) => {
    const { runtime } = setup(
      program([assign(0, literal(input, "LREAL"), 2, type)], [scalar("n", type)]),
    );
    expect(value(runtime.scanOnce())).toBe(expected);
  });

  it.each([
    ["+", 7, 2, 9],
    ["-", 7, 2, 5],
    ["*", 7, 2, 14],
    ["/", -7, 2, -3],
    ["MOD", -7, 2, -1],
    ["AND", 6, 3, 2],
    ["OR", 6, 3, 7],
    ["XOR", 6, 3, 5],
    ["=", 2, 2, true],
    ["<>", 2, 2, false],
    ["<", 1, 2, true],
    [">", 1, 2, false],
    ["<=", 2, 2, true],
    [">=", 2, 2, true],
    ["AND", true, false, false],
    ["OR", false, true, true],
    ["XOR", true, true, false],
  ] as const)("evaluates %s (%s, %s)", (operator, left, right, expected) => {
    const type =
      typeof expected === "boolean"
        ? "BOOL"
        : ["AND", "OR", "XOR"].includes(operator)
          ? "WORD"
          : "INT";
    const { runtime } = setup(
      program(
        [assign(0, binary(operator, literal(left), literal(right), type), 2, type)],
        [scalar("n", type)],
      ),
    );
    expect(value(runtime.scanOnce())).toBe(expected);
  });

  it.each([
    ["+", -2, -2],
    ["-", 2, -2],
    ["NOT", 0, 65535],
    ["NOT", true, false],
  ] as const)("evaluates unary %s %s", (operator, operand, expected) => {
    const type = typeof operand === "boolean" ? "BOOL" : operator === "NOT" ? "WORD" : "INT";
    const { runtime } = setup(
      program(
        [
          assign(
            0,
            { kind: "unary", operator, operand: literal(operand), dataType: type, span },
            2,
            type,
          ),
        ],
        [scalar("n", type)],
      ),
    );
    expect(value(runtime.scanOnce())).toBe(expected);
  });

  it("coerces every typed REAL operator result, including unary signs", () => {
    const { runtime } = setup(
      program(
        [
          assign(0, binary("+", literal(32767), literal(1))),
          assign(
            1,
            { kind: "unary", operator: "-", operand: literal(0.1, "REAL"), dataType: "REAL", span },
            2,
            "LREAL",
          ),
          assign(2, binary("+", literal(0.1, "REAL"), literal(0, "REAL"), "REAL"), 3, "LREAL"),
        ],
        [scalar("n"), scalar("signed", "LREAL"), scalar("rounded", "LREAL")],
      ),
    );
    const snapshot = runtime.scanOnce();
    expect(value(snapshot)).toBe(-32768);
    expect(value(snapshot, 1)).toBe(Math.fround(-0.1));
    expect(value(snapshot, 2)).toBe(Math.fround(0.1));
  });

  it("executes IF/ELSIF/ELSE and CASE values, ranges and ELSE", () => {
    const { runtime } = setup(
      program([
        {
          kind: "if",
          branches: [
            { condition: literal(false), body: [assign(0, literal(99))], span },
            { condition: literal(true), body: [assign(0, literal(2))], span },
          ],
          elseBody: [assign(0, literal(88))],
          span,
        },
        {
          kind: "case",
          selector: ref(0),
          branches: [
            {
              labels: [
                { kind: "value", value: 1, span },
                { kind: "range", lower: 2, upper: 4, span },
              ],
              body: [assign(0, literal(5))],
              span,
            },
          ],
          elseBody: [assign(0, literal(77))],
          span,
        },
        {
          kind: "if",
          branches: [{ condition: literal(false), body: [], span }],
          elseBody: [increment()],
          span,
        },
        { kind: "case", selector: ref(0), branches: [], elseBody: [increment()], span },
      ]),
    );
    expect(value(runtime.scanOnce())).toBe(7);
  });

  it("executes ascending/descending FOR, WHILE, REPEAT, nested EXIT and RETURN", () => {
    const loopVariable = { ...ref(1), dataType: "INT" as const };
    const { runtime } = setup(
      program([
        {
          kind: "for",
          variable: loopVariable,
          from: literal(1),
          to: literal(3),
          step: literal(1),
          body: [increment()],
          span,
        },
        {
          kind: "for",
          variable: loopVariable,
          from: literal(3),
          to: literal(1),
          step: literal(-1),
          body: [increment()],
          span,
        },
        {
          kind: "for",
          variable: loopVariable,
          from: literal(3),
          to: literal(1),
          step: literal(1),
          body: [assign(0, literal(99))],
          span,
        },
        {
          kind: "while",
          condition: binary("<", ref(0), literal(8), "BOOL"),
          body: [increment()],
          span,
        },
        { kind: "repeat", body: [increment()], until: literal(true), span },
        {
          kind: "while",
          condition: literal(true),
          body: [
            { kind: "repeat", body: [{ kind: "exit", span }], until: literal(false), span },
            increment(),
            {
              kind: "if",
              branches: [{ condition: literal(true), body: [{ kind: "exit", span }], span }],
              elseBody: [],
              span,
            },
          ],
          span,
        },
        {
          kind: "for",
          variable: loopVariable,
          from: literal(1),
          to: literal(3),
          step: literal(1),
          body: [{ kind: "return", span }],
          span,
        },
        assign(0, literal(999)),
      ]),
    );
    expect(value(runtime.scanOnce())).toBe(10);
  });

  it.each(["INT", "REAL", "LREAL"] as const)(
    "faults on %s division by zero with the expression span and clears outputs",
    (type) => {
      const { runtime, clock } = setup(
        program(
          [
            assign(0, literal(true), 2, "BOOL"),
            assign(1, binary("/", literal(1, type), literal(0, type), type), 1, type),
          ],
          [output, scalar("n", type)],
        ),
      );
      runtime.run();
      clock.advance(10);
      expect(runtime.state).toBe("FAULT");
      expect(runtime.diagnostic).toEqual({
        code: "runtime.division-by-zero",
        severity: "error",
        pou: "Test",
        span: at(8),
        args: {},
      });
      expect(runtime.snapshot().outputs[0]).toBe(false);
      runtime.run();
      runtime.stop();
      clock.advance(100);
      expect(runtime.state).toBe("FAULT");
      expect(runtime.snapshot().scanCount).toBe(1);
      runtime.coldReset();
      expect(runtime.state).toBe("STOP");
      expect(runtime.diagnostic).toBeNull();
    },
  );

  it("faults on a zero FOR step", () => {
    const { runtime } = setup(
      program([
        {
          kind: "for",
          variable: { ...ref(1), dataType: "INT" },
          from: literal(0),
          to: literal(2),
          step: { ...literal(0), span: at(9) },
          body: [],
          span,
        },
      ]),
    );
    runtime.scanOnce();
    expect(runtime.diagnostic).toMatchObject({ code: "runtime.for-by-zero", span: at(9) });
  });

  it.each(["while", "repeat", "for"] as const)("bounds %s loops by a per-scan watchdog", (kind) => {
    const loop: Statement =
      kind === "while"
        ? { kind, condition: literal(true), body: [], span: at(4) }
        : kind === "repeat"
          ? { kind, until: literal(false), body: [], span: at(4) }
          : {
              kind,
              variable: { ...ref(1, "DINT"), dataType: "DINT" },
              from: literal(0),
              to: literal(WATCHDOG_LIMIT + 1, "DINT"),
              step: literal(1),
              body: [],
              span: at(4),
            };
    const { runtime } = setup(program([loop], [scalar("n"), scalar("i", "DINT")]));
    runtime.scanOnce();
    expect(runtime.diagnostic).toEqual({
      code: "runtime.watchdog",
      severity: "error",
      pou: "Test",
      span: at(4),
      args: { limit: 200000 },
    });
  });

  it("counts nested iterations together and allows exactly 200,000", () => {
    const loop: Statement = {
      kind: "for",
      variable: { ...ref(1, "DINT"), dataType: "DINT" },
      from: literal(1),
      to: literal(WATCHDOG_LIMIT, "DINT"),
      step: literal(1),
      body: [],
      span,
    };
    const { runtime } = setup(program([loop], [scalar("n"), scalar("i", "DINT")]));
    runtime.scanOnce();
    expect(runtime.state).toBe("STOP");
    runtime.scanOnce();
    expect(runtime.state).toBe("STOP");
    runtime.load(
      program(
        [loop, { kind: "repeat", body: [], until: literal(true), span: at(7) }],
        [scalar("n"), scalar("i", "DINT")],
      ),
    );
    runtime.scanOnce();
    expect(runtime.diagnostic).toMatchObject({ code: "runtime.watchdog", span: at(7) });
  });

  it("faults on REAL overflow at the expression span", () => {
    const { runtime } = setup(
      program(
        [assign(0, binary("*", literal(3e38, "REAL"), literal(2, "REAL"), "REAL"), 2, "REAL")],
        [scalar("n", "REAL")],
      ),
    );
    runtime.scanOnce();
    expect(runtime.diagnostic).toMatchObject({ code: "runtime.invalid-value", span: at(8) });
  });

  it("emergency stop clears outputs immediately and release never restarts", () => {
    const { runtime, clock } = setup(program([assign(0, literal(true), 2, "BOOL")], [output]));
    runtime.run();
    clock.advance(10);
    expect(runtime.snapshot().outputs[0]).toBe(true);
    runtime.setEmergencyStop(true);
    expect(runtime.state).toBe("ESTOP");
    expect(value(runtime.snapshot())).toBe(false);
    runtime.stop();
    runtime.run();
    runtime.scanOnce();
    clock.advance(20);
    expect(runtime.state).toBe("ESTOP");
    expect(runtime.snapshot().scanCount).toBe(1);
    runtime.coldReset();
    expect(runtime.state).toBe("ESTOP");
    runtime.setEmergencyStop(false);
    expect(runtime.state).toBe("STOP");
    clock.advance(20);
    expect(runtime.snapshot().scanCount).toBe(0);
    runtime.run();
    clock.advance(10);
    expect(runtime.snapshot().outputs[0]).toBe(true);
  });

  it("records last execution per statement, sorts columns and omits stale annotations", () => {
    const first = { ...increment(0, 5), span: at(5, 20) };
    const second = { ...increment(0, 5), span: at(5, 2) };
    const { runtime } = setup(
      program([
        {
          kind: "if",
          branches: [
            {
              condition: binary("=", ref(0), literal(0), "BOOL"),
              body: [
                {
                  kind: "for",
                  variable: { ...ref(1), dataType: "INT" },
                  from: literal(1),
                  to: literal(2),
                  step: literal(1),
                  body: [first, second],
                  span,
                },
              ],
              span,
            },
          ],
          elseBody: [],
          span,
        },
      ]),
    );
    const snapshot = runtime.scanOnce();
    expect(
      snapshot.annotations[5]?.map((entry) => [entry.span.column, entry.values[0]?.value]),
    ).toEqual([
      [2, 4],
      [20, 3],
    ]);
    snapshot.annotations[5]![0]!.values[0]!.value = 99;
    expect(runtime.snapshot().annotations[5]?.[0]?.values[0]?.value).toBe(4);
    expect(runtime.scanOnce().annotations).toEqual({});
    expect(JSON.parse(JSON.stringify(runtime.snapshot()))).toEqual(runtime.snapshot());
  });

  it("delegates functions and FB calls, retains omitted inputs and resets FB private state", () => {
    const times: number[] = [];
    const library: RuntimeLibrary = {
      callFunction: (name, args) => {
        expect(name).toBe("ABS");
        return Math.abs(Number(args[0]));
      },
      createFunctionBlock: () => {
        let calls = 0;
        return {
          inputs: [
            { dataType: "BOOL", value: false },
            { dataType: "TIME", value: 0 },
          ],
          outputs: [
            { dataType: "BOOL", value: false },
            { dataType: "TIME", value: 0 },
          ],
          execute(now) {
            times.push(now);
            this.outputs = [
              { dataType: "BOOL", value: Boolean(this.inputs[0]?.value) },
              { dataType: "TIME", value: ++calls },
            ];
          },
        };
      },
    };
    const { runtime, clock } = setup(
      program(
        [
          {
            kind: "assignment",
            target: {
              kind: "fbMember",
              variable: 1,
              port: "input",
              member: 0,
              dataType: "BOOL",
              span,
            },
            value: literal(true),
            span: at(2),
          },
          {
            kind: "fbCall",
            variable: 1,
            inputs: [{ name: "PT", input: 1, value: literal(50, "TIME"), span }],
            span: at(3),
          },
          { kind: "fbCall", variable: 1, inputs: [], span: at(4) },
          assign(
            0,
            { kind: "functionCall", function: "ABS", args: [literal(-3)], dataType: "INT", span },
            5,
          ),
          assign(
            2,
            { kind: "fbMember", variable: 1, port: "output", member: 1, dataType: "TIME", span },
            6,
            "TIME",
          ),
        ],
        [
          scalar("n"),
          {
            kind: "functionBlock",
            name: "timer",
            key: "TIMER",
            fbType: "TON",
            initialValue: null,
            span,
          },
          scalar("seen", "TIME"),
        ],
      ),
      { library },
    );
    runtime.run();
    clock.advance(20);
    expect(times).toEqual([10, 10, 20, 20]);
    expect(value(runtime.snapshot())).toBe(3);
    expect(value(runtime.snapshot(), 2)).toBe(4);
    expect(runtime.snapshot().annotations[3]?.[0]?.values).toEqual([
      { dataType: "BOOL", value: true },
      { dataType: "TIME", value: 3 },
    ]);
    runtime.coldReset();
    expect(value(runtime.snapshot())).toBe(0);
    expect(runtime.snapshot().variables[1]).toMatchObject({
      inputs: [{ value: false }, { value: 0 }],
      outputs: [{ value: false }, { value: 0 }],
    });
    runtime.scanOnce();
    expect(value(runtime.snapshot(), 2)).toBe(2);
  });
});

it("uses the configured cycle and ignores running without a program", () => {
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock), intervalMs: 25 });
  runtime.run();
  expect(runtime.state).toBe("STOP");
  expect(runtime.scanOnce().scanCount).toBe(0);
  runtime.load(program([increment()]));
  runtime.run();
  clock.advance(100);
  expect(value(runtime.snapshot())).toBe(4);
  for (const intervalMs of [0, -1, Infinity, NaN]) {
    expect(() => createRuntime({ clock, ticker: new VirtualTicker(clock), intervalMs })).toThrow(
      RangeError,
    );
  }
});

it("does not publish outputs after an emergency stop in a scan stage", () => {
  const clock = new VirtualClock();
  const published: boolean[] = [];
  const runtime = createRuntime({
    clock,
    ticker: new VirtualTicker(clock),
    stages: {
      applyPendingWrites: () => runtime.setEmergencyStop(true),
      applyForces: () => {
        throw new Error("Must not reach forces after emergency stop");
      },
      writeOutputs: (image) => published.push(image[0]),
    },
  });
  runtime.load(program([assign(0, literal(true), 2, "BOOL")], [output]));
  runtime.run();
  clock.advance(10);
  expect(runtime.state).toBe("ESTOP");
  expect(published.every((bit) => !bit)).toBe(true);
  expect(runtime.snapshot().annotations).toEqual({});
});

it("keeps ESTOP latched if a library stops the scan before a later expression faults", () => {
  const clock = new VirtualClock();
  const runtime = createRuntime({
    clock,
    ticker: new VirtualTicker(clock),
    library: {
      createFunctionBlock: () => {
        throw new Error("No blocks in this test");
      },
      callFunction: () => {
        runtime.setEmergencyStop(true);
        return 1;
      },
    },
  });
  runtime.load(
    program([
      assign(
        0,
        binary(
          "+",
          { kind: "functionCall", function: "ABS", args: [literal(1)], dataType: "INT", span },
          binary("/", literal(1), literal(0)),
        ),
      ),
    ]),
  );
  runtime.run();
  clock.advance(10);
  expect(runtime.state).toBe("ESTOP");
  expect(runtime.diagnostic).toBeNull();
});

it("uses one scan start for all FB calls and reports elapsed time through the injected clock", () => {
  const clock = new VirtualClock();
  const times: number[] = [];
  const library: RuntimeLibrary = {
    callFunction: () => 0,
    createFunctionBlock: () => ({
      inputs: [],
      outputs: [],
      execute(now) {
        times.push(now);
        clock.advance(1);
      },
    }),
  };
  const { runtime } = setup(
    program(
      [
        { kind: "fbCall", variable: 0, inputs: [], span: at(2) },
        { kind: "fbCall", variable: 0, inputs: [], span: at(3) },
      ],
      [
        {
          kind: "functionBlock",
          name: "block",
          key: "BLOCK",
          fbType: "TON",
          initialValue: null,
          span,
        },
      ],
    ),
    { clock, ticker: new VirtualTicker(clock), library },
  );
  clock.advance(5);
  const snapshot = runtime.scanOnce();
  expect(times).toEqual([5, 5]);
  expect(snapshot.lastExecutionTimeMs).toBe(2);
});

it("turns off outputs on host failures and propagates configuration errors", () => {
  const clock = new VirtualClock();
  const runtime = createRuntime({
    clock,
    ticker: new VirtualTicker(clock),
    stages: {
      applyPendingWrites: () => {
        throw new Error("Host failure");
      },
    },
  });
  runtime.load(program([], [output]));
  runtime.run();
  expect(() => clock.advance(10)).toThrow("Host failure");
  expect(runtime.state).toBe("FAULT");
  expect(runtime.snapshot().outputs[0]).toBe(false);
});

it("keeps closure-owned FB outputs live across scans while coercing and annotating them", () => {
  const outputs = [{ dataType: "INT" as const, value: 0 }];
  let calls = 0;
  const { runtime } = setup(
    program(
      [
        { kind: "fbCall", variable: 1, inputs: [], span: at(2) },
        assign(
          0,
          { kind: "fbMember", variable: 1, port: "output", member: 0, dataType: "INT", span },
          3,
        ),
      ],
      [
        scalar("n"),
        {
          kind: "functionBlock",
          name: "counter",
          key: "COUNTER",
          fbType: "CTU",
          initialValue: null,
          span,
        },
      ],
    ),
    {
      library: {
        callFunction: () => 0,
        createFunctionBlock: () => ({
          inputs: [],
          outputs,
          execute: () => {
            outputs[0] = { dataType: "INT", value: 32767 + ++calls };
          },
        }),
      },
    },
  );
  for (const expected of [-32768, -32767, -32766]) {
    const snapshot = runtime.scanOnce();
    expect(value(snapshot)).toBe(expected);
    expect(snapshot.annotations[2]?.[0]?.values).toEqual([{ dataType: "INT", value: expected }]);
    expect(snapshot.variables[1]).toMatchObject({
      outputs: [{ dataType: "INT", value: expected }],
    });
    expect(outputs[0]?.value).toBe(expected);
  }
});

it("keeps FAULT and its diagnostic latched across emergency stop activation and release", () => {
  const { runtime, clock } = setup(
    program(
      [assign(0, literal(true), 2, "BOOL"), assign(1, binary("/", literal(1), literal(0)))],
      [output, scalar("n")],
    ),
  );
  runtime.run();
  clock.advance(10);
  const diagnostic = runtime.diagnostic;
  const count = runtime.snapshot().scanCount;
  expect(runtime.state).toBe("FAULT");
  expect(diagnostic?.code).toBe("runtime.division-by-zero");

  runtime.setEmergencyStop(true);
  expect(runtime.state).toBe("ESTOP");
  expect(runtime.diagnostic).toEqual(diagnostic);
  runtime.stop();
  runtime.setEmergencyStop(true);
  runtime.run();
  runtime.scanOnce();
  clock.advance(30);
  expect(runtime.state).toBe("ESTOP");
  expect(runtime.snapshot().scanCount).toBe(count);
  expect(runtime.snapshot().outputs.every((bit) => !bit)).toBe(true);

  runtime.setEmergencyStop(false);
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toEqual(diagnostic);
  runtime.setEmergencyStop(false);
  runtime.stop();
  runtime.run();
  runtime.scanOnce();
  clock.advance(30);
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toEqual(diagnostic);
  expect(runtime.snapshot().scanCount).toBe(count);
  expect(runtime.snapshot().outputs.every((bit) => !bit)).toBe(true);
});

it.each(["coldReset", "load"] as const)(
  "allows %s during emergency stop to clear FAULT without starting execution",
  (reset) => {
    const ir = program(
      [
        assign(0, literal(true), 2, "BOOL"),
        {
          kind: "if",
          branches: [
            {
              condition: binary("=", ref(1), literal(0), "BOOL"),
              body: [assign(1, literal(1), 3), assign(1, binary("/", literal(1), literal(0)), 4)],
              span,
            },
          ],
          elseBody: [],
          span,
        },
      ],
      [output, scalar("n")],
    );
    const { runtime, clock } = setup(ir);
    runtime.run();
    clock.advance(10);
    expect(runtime.state).toBe("FAULT");
    expect(value(runtime.snapshot(), 1)).toBe(1);
    runtime.setEmergencyStop(true);
    if (reset === "coldReset") runtime.coldReset();
    else runtime.load(ir);
    expect(runtime.state).toBe("ESTOP");
    expect(runtime.diagnostic).toBeNull();
    expect(value(runtime.snapshot(), 1)).toBe(0);
    expect(runtime.snapshot().scanCount).toBe(0);
    expect(runtime.snapshot().annotations).toEqual({});
    expect(runtime.snapshot().outputs.every((bit) => !bit)).toBe(true);
    runtime.run();
    runtime.scanOnce();
    clock.advance(30);
    expect(runtime.state).toBe("ESTOP");
    expect(runtime.snapshot().scanCount).toBe(0);

    runtime.setEmergencyStop(false);
    expect(runtime.state).toBe("STOP");
    expect(runtime.diagnostic).toBeNull();
    clock.advance(30);
    expect(runtime.snapshot().scanCount).toBe(0);
    runtime.run();
    expect(runtime.state).toBe("RUN");
    expect(runtime.diagnostic).toBeNull();
  },
);

it("releases emergency stop from RUN to STOP without an automatic restart", () => {
  const { runtime, clock } = setup(
    program([increment(), assign(1, literal(true), 3, "BOOL")], [scalar("n"), output]),
  );
  runtime.run();
  clock.advance(10);
  expect(runtime.snapshot().outputs[0]).toBe(true);
  runtime.setEmergencyStop(true);
  expect(runtime.state).toBe("ESTOP");
  expect(runtime.snapshot().outputs[0]).toBe(false);
  runtime.run();
  runtime.scanOnce();
  clock.advance(30);
  expect(runtime.snapshot().scanCount).toBe(1);
  runtime.setEmergencyStop(false);
  expect(runtime.state).toBe("STOP");
  expect(runtime.diagnostic).toBeNull();
  clock.advance(30);
  expect(value(runtime.snapshot())).toBe(1);
  expect(runtime.snapshot().scanCount).toBe(1);
  runtime.run();
  clock.advance(10);
  expect(value(runtime.snapshot())).toBe(2);
  expect(runtime.snapshot().outputs[0]).toBe(true);
});

import { describe, expect, it } from "vitest";
import { compileProject, lex, parseConfiguration } from "./index.js";

const counter = "PROGRAM Counter VAR n : INT; END_VAR n := n + 1; END_PROGRAM";
const config = (
  programs = "PROGRAM A WITH T : Counter;",
  task = "INTERVAL := T#20ms, PRIORITY := 1",
) =>
  `CONFIGURATION Plant RESOURCE Station ON Anything TASK T (${task}); ${programs} END_RESOURCE END_CONFIGURATION`;
const compile = (source = config(), pous = [counter], types: string[] = []) =>
  compileProject(pous, types, source);

it("shares PROGRAM bodies, allocates distinct storage, and preserves declaration order", () => {
  const result = compile(config("PROGRAM B WITH T : Counter; PROGRAM A WITH T : Counter;"));
  expect(result.diagnostics).toEqual([]);
  const ir = result.ir!;
  expect(ir).toMatchObject({
    kind: "configuration",
    name: "Plant",
    explicit: true,
    resource: { name: "Station", tasks: [{ name: "T", intervalMs: 20, priority: 1 }] },
  });
  expect(ir.programs).toHaveLength(1);
  expect(ir.resource.programs).toEqual([
    { name: "B", program: 0, task: 0, storage: [{ kind: "variable", variable: 0 }] },
    { name: "A", program: 0, task: 0, storage: [{ kind: "variable", variable: 1 }] },
  ]);
  expect(ir.variables.map((v) => [v.name, v.key, v.path])).toEqual([
    ["B.n", "B.N", ["B", "n"]],
    ["A.n", "A.N", ["A", "n"]],
  ]);
  expect(JSON.parse(JSON.stringify(ir))).toEqual(ir);
});

it("supplies an implicit configuration from the existing project fields", () => {
  const ir = compileProject([counter], [], undefined, {
    name: "Legacy",
    resource: "Cpu",
    task: { name: "Scan", intervalMs: 50, priority: 8 },
    instance: "Count1",
  }).ir!;
  expect(ir).toMatchObject({
    name: "Legacy",
    explicit: false,
    resource: {
      name: "Cpu",
      tasks: [{ name: "Scan", intervalMs: 50, priority: 8 }],
      programs: [{ name: "Count1" }],
    },
  });
  expect(ir.variables[0]!.name).toBe("Count1.n");
  expect(compileProject([counter]).ir?.variables[0]!.name).toBe("mainInstance.n");
});

it("checks unused PROGRAMs without allocating or running them", () => {
  const unused = "PROGRAM Unused VAR x : INT; END_VAR x := x + 10; END_PROGRAM";
  const result = compile(config(), [counter, unused]);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir!.programs.map((program) => program.name)).toEqual(["Counter", "Unused"]);
  expect(result.ir!.variables.map((v) => v.name)).toEqual(["A.n"]);
  expect(
    compile(config(), [counter, "PROGRAM Unused x := Missing; END_PROGRAM"]).diagnostics,
  ).toContainEqual(
    expect.objectContaining({ code: "name.undeclared", sourceIndex: 1, pou: "Unused" }),
  );
});

it.each([{ sources: [] }, { sources: [counter, "PROGRAM Other END_PROGRAM"] }])(
  "requires a source for zero or several PROGRAMs",
  ({ sources }) => {
    expect(compileProject(sources).diagnostics).toContainEqual(
      expect.objectContaining({ code: "pou.program-count", args: { found: sources.length } }),
    );
  },
);

describe("configuration diagnostics", () => {
  it.each([
    [config() + " CONFIGURATION Other END_CONFIGURATION", "config.configuration-count"],
    [
      config().replace("END_CONFIGURATION", "RESOURCE Other ON Cpu END_RESOURCE END_CONFIGURATION"),
      "config.resource-count",
    ],
    ["CONFIGURATION Plant END_CONFIGURATION", "config.resource-count"],
    [
      config().replace("PROGRAM A", "TASK t (INTERVAL := T#10ms, PRIORITY := 0); PROGRAM A"),
      "config.name-collision",
    ],
    [config().replace("TASK T (INTERVAL := T#20ms, PRIORITY := 1);", ""), "config.task-count"],
    [config(""), "config.no-instances"],
    [config("PROGRAM A WITH Missing : Counter;"), "config.unknown-task"],
    [config("PROGRAM A : Counter;"), "config.missing-task"],
    [config("PROGRAM A WITH T : Missing;"), "config.program-type"],
    [config("PROGRAM A WITH T : INT;"), "config.program-type"],
    [config("PROGRAM A WITH T : Block;"), "config.program-type"],
    [config("PROGRAM A WITH T : Func;"), "config.program-type"],
    [config("PROGRAM A WITH T : Counter; PROGRAM a WITH T : Counter;"), "config.name-collision"],
    [config("PROGRAM TON WITH T : Counter;"), "config.name-collision"],
    [config("PROGRAM ABS WITH T : Counter;"), "config.name-collision"],
    [config("PROGRAM Counter WITH T : Counter;"), "config.name-collision"],
    [config("PROGRAM Recipe WITH T : Counter;"), "config.name-collision"],
    [config("PROGRAM Plant WITH T : Counter;"), "config.name-collision"],
    [config("PROGRAM Station WITH T : Counter;"), "config.name-collision"],
    [config("PROGRAM t WITH T : Counter;"), "config.name-collision"],
    [config().replace("CONFIGURATION Plant", "CONFIGURATION Counter"), "config.name-collision"],
    [config().replace("RESOURCE Station", "RESOURCE Counter"), "config.name-collision"],
    [config().replaceAll(" T ", " Counter "), "config.name-collision"],
    [config("PROGRAM A WITH T : Counter;", "SINGLE := trigger, PRIORITY := 1"), "config.single"],
    [
      config(
        "PROGRAM A WITH T : Counter;",
        "INTERVAL := T#10ms, INTERVAL := T#20ms, PRIORITY := 1",
      ),
      "config.task-parameter",
    ],
  ])("reports %s as %s in the configuration source", (source, code) => {
    const result = compile(
      source,
      [counter, "FUNCTION_BLOCK Block END_FUNCTION_BLOCK", "FUNCTION Func END_FUNCTION"],
      ["TYPE Recipe : INT; END_TYPE"],
    );
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code,
        sourceKind: "configuration",
        sourceIndex: 0,
        pou: source.includes("CONFIGURATION Counter") ? "Counter" : "Plant",
        span: expect.any(Object),
      }),
    );
  });

  it.each([
    "T#15ms",
    "T#0s",
    "T#5ms",
    "T#-10ms",
    "T#-0h20ms",
    "T#1h10ms",
    "T#10.0000000000000001ms",
    "LT#10000001ns",
    "period",
    "10",
    "T#10ms + T#10ms",
  ])("rejects INTERVAL %s", (literal) => {
    expect(
      compile(config(undefined, `INTERVAL := ${literal}, PRIORITY := 0`)).diagnostics,
    ).toContainEqual(
      expect.objectContaining({ code: "config.interval", sourceKind: "configuration" }),
    );
  });
  it.each(["T#10ms", "T#1h", "LT#10000000ns", "LT#0.01s", "T#250ms"])(
    "accepts INTERVAL %s",
    (literal) => {
      expect(
        compile(config(undefined, `INTERVAL := ${literal}, PRIORITY := 0`)).diagnostics,
      ).toEqual([]);
    },
  );
  it.each(["-1", "65536", "1.5", "p", "1 + 1"])("rejects PRIORITY %s", (literal) => {
    expect(
      compile(config(undefined, `INTERVAL := T#10ms, PRIORITY := ${literal}`)).diagnostics,
    ).toContainEqual(
      expect.objectContaining({ code: "config.priority", sourceKind: "configuration" }),
    );
  });
  it.each(["0", "65535", "16#FFFF"])(
    "accepts priority %s and reversed parameter order",
    (priority) => {
      expect(
        compile(config(undefined, `PRIORITY := ${priority}, INTERVAL := T#10ms`)).diagnostics,
      ).toEqual([]);
    },
  );
  it.each([
    ["INTERVAL := T#20ms PRIORITY := 1", "PRIORITY"],
    ["PRIORITY := 1 INTERVAL := T#20ms", "INTERVAL"],
  ])("reports the missing comma in %s at %s", (parameters, found) => {
    const source = config(undefined, parameters);
    const result = compile(source);
    const column = source.indexOf(found) + 1;
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics).toEqual([
      {
        code: "syntax.expected-token",
        severity: "error",
        args: { expected: ",", found },
        sourceKind: "configuration",
        sourceIndex: 0,
        pou: "Plant",
        span: { line: 1, column, endLine: 1, endColumn: column + found.length },
      },
    ]);
  });
  it.each(["INTERVAL := T#10ms", "PRIORITY := 0"])("requires both parameters: %s", (parameters) => {
    expect(compile(config(undefined, parameters)).ir).toBeUndefined();
  });
  it("allows 64 instances and rejects 65", () => {
    const instances = (n: number) =>
      Array.from({ length: n }, (_, i) => `PROGRAM P${i} WITH T : Counter;`).join("\n");
    expect(compile(config(instances(64))).diagnostics).toEqual([]);
    expect(compile(config(instances(65))).diagnostics).toContainEqual(
      expect.objectContaining({ code: "config.instance-limit", sourceKind: "configuration" }),
    );
  });
  it("identifies lexer and parser errors as configuration source diagnostics", () => {
    for (const source of [
      config().replace("Anything", "@"),
      config().replace("Station", "IF"),
      config().slice(0, -4),
    ])
      expect(compile(source).diagnostics).toContainEqual(
        expect.objectContaining({
          sourceKind: "configuration",
          sourceIndex: 0,
          span: expect.any(Object),
        }),
      );
  });
});

it("keeps task parameter names as ordinary identifiers and accepts arbitrary ON identifiers", () => {
  expect(
    lex("INTERVAL SINGLE PRIORITY")
      .tokens?.slice(0, 3)
      .map((token) => token.kind),
  ).toEqual(["identifier", "identifier", "identifier"]);
  expect(compile(config().replace("Anything", "SomeCpu")).diagnostics).toEqual([]);
  expect(
    compileProject([
      "PROGRAM P VAR interval, single, priority : INT; END_VAR interval := single + priority; END_PROGRAM",
    ]).diagnostics,
  ).toEqual([]);
  expect(parseConfiguration(config()).ast?.tasks[0]?.intervalMs).toBe(20);
});

it("lowers multiple cyclic and event tasks with independent bindings", () => {
  const source = `CONFIGURATION Plant
VAR_GLOBAL enabled : BOOL; END_VAR
RESOURCE Station ON Cpu VAR_GLOBAL ack : Flag; END_VAR
TASK Fast (INTERVAL := T#10ms, PRIORITY := 65535);
TASK Edge (PRIORITY := 0, SINGLE := aCk);
TASK InputEdge (SINGLE := %IX0.7, PRIORITY := 1);
PROGRAM A WITH eDgE : Counter;
PROGRAM B WITH Fast : Counter;
PROGRAM C WITH InputEdge : Counter;
END_RESOURCE END_CONFIGURATION`;
  const result = compile(source, [counter], ["TYPE Flag : BOOL; END_TYPE"]);
  expect(result.diagnostics).toEqual([]);
  expect(result.ir!.resource.tasks).toEqual([
    { name: "Fast", intervalMs: 10, priority: 65535 },
    { name: "Edge", priority: 0, single: { kind: "variable", variable: 1 } },
    {
      name: "InputEdge",
      priority: 1,
      single: { kind: "address", address: { area: "I", size: "X", byte: 0, bit: 7 } },
    },
  ]);
  expect(result.ir!.resource.programs.map((instance) => instance.task)).toEqual([1, 0, 2]);
  expect(JSON.parse(JSON.stringify(result.ir))).toEqual(result.ir);
});

it.each(["PRIORITY := 0", "INTERVAL := T#10ms, SINGLE := %IX0.0, PRIORITY := 0"])(
  "requires exactly one trigger: %s",
  (parameters) => {
    expect(compile(config(undefined, parameters)).diagnostics).toContainEqual(
      expect.objectContaining({
        code: "config.task-trigger",
        sourceKind: "configuration",
        pou: "Plant",
      }),
    );
  },
);

it.each([
  "missing",
  "local",
  "constantFlag",
  "numberValue",
  "arrayValue",
  "recordValue",
  "referenceValue",
  "timerValue",
  "arrayValue[1]",
  "recordValue.flag",
  "TRUE",
  "flag AND TRUE",
  "%QX0.0",
  "%IX64.0",
  "%IX0.8",
  "",
])("rejects SINGLE := %s with a configuration diagnostic", (input) => {
  const source = `CONFIGURATION Plant
VAR_GLOBAL CONSTANT constantFlag : BOOL := TRUE; END_VAR
VAR_GLOBAL flag : BOOL; numberValue : INT; arrayValue : ARRAY[1..2] OF BOOL;
recordValue : RecordType; referenceValue : REF_TO BOOL; timerValue : TON; END_VAR
RESOURCE Station ON Cpu TASK T (SINGLE := ${input}, PRIORITY := 0);
PROGRAM A WITH T : Counter; END_RESOURCE END_CONFIGURATION`;
  const result = compile(
    source,
    [counter.replace("n : INT", "n : INT; local : BOOL")],
    ["TYPE RecordType : STRUCT flag : BOOL; END_STRUCT; END_TYPE"],
  );
  expect(result.ir).toBeUndefined();
  expect(result.diagnostics).toContainEqual(
    expect.objectContaining({
      code: "config.single",
      sourceKind: "configuration",
      sourceIndex: 0,
      pou: "Plant",
      span: expect.any(Object),
    }),
  );
});

it("allows sixteen tasks and rejects seventeen in the configuration source", () => {
  const source = (count: number) => `CONFIGURATION Plant RESOURCE Station ON Cpu
${Array.from({ length: count }, (_, index) => `TASK Task${index} (INTERVAL := T#10ms, PRIORITY := ${index});`).join("\n")}
PROGRAM A WITH Task0 : Counter; END_RESOURCE END_CONFIGURATION`;
  expect(compile(source(16)).diagnostics).toEqual([]);
  expect(compile(source(17)).diagnostics).toContainEqual(
    expect.objectContaining({
      code: "config.task-count",
      sourceKind: "configuration",
      sourceIndex: 0,
      pou: "Plant",
    }),
  );
});

it("rejects duplicate SINGLE parameters", () => {
  expect(
    compile(config(undefined, "SINGLE := %IX0.0, SINGLE := %IX0.1, PRIORITY := 0")).diagnostics,
  ).toContainEqual(
    expect.objectContaining({ code: "config.task-parameter", args: { name: "SINGLE" } }),
  );
});

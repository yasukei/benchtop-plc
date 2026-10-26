import type { RuntimeSnapshot, StatementAnnotation } from "@benchtop-plc/core";
import { describe, expect, it } from "vitest";
import { mapAnnotations, spanRange } from "./mapping.js";

const entry = (line: number, column: number, value: number): StatementAnnotation => ({
  span: { line, column, endLine: line, endColumn: column + 1 },
  values: [{ dataType: "INT", value }],
});
const snapshot: RuntimeSnapshot = {
  scanCount: 1,
  tasks: [],
  lastExecutionTimeMs: 0,
  inputs: [0, ...Array<number>(63).fill(0)],
  outputs: [0, ...Array<number>(63).fill(0)],
  variables: [],
  forced: [],
  annotations: [],
};

describe("annotation mapping", () => {
  it("uses line ends and column order for multiple statements, and the start of multiline calls", () => {
    const source = "a := 1; b := 2;\ntimer(\n  IN := TRUE);\n";
    const result = mapAnnotations(
      source,
      {
        ...snapshot,
        annotations: [
          {
            pou: "Main",
            instance: "mainInstance",
            scanCount: 1,
            lines: {
              2: [
                {
                  ...entry(2, 1, 0),
                  span: { line: 2, column: 1, endLine: 3, endColumn: 15 },
                  values: [
                    { dataType: "BOOL", value: true },
                    { dataType: "TIME", value: 1500 },
                  ],
                },
              ],
              1: [entry(1, 9, 2), entry(1, 1, 1)],
            },
          },
        ],
      },
      true,
    );
    expect(result).toEqual([
      {
        line: 1,
        position: 15,
        values: [
          { text: "1", dataType: "INT" },
          { text: "2", dataType: "INT" },
        ],
      },
      {
        line: 2,
        position: 22,
        values: [
          { text: "TRUE", dataType: "BOOL" },
          { text: "T#1s500ms", dataType: "TIME" },
        ],
      },
    ]);
  });
  it("formats each type using the shared IEC formatter and accepts CRLF", () => {
    expect(
      mapAnnotations(
        "first\r\nsecond",
        {
          ...snapshot,
          annotations: [
            {
              pou: "Main",
              instance: "mainInstance",
              scanCount: 1,
              lines: {
                1: [
                  {
                    ...entry(1, 1, 0),
                    values: [
                      { dataType: "BOOL", value: false },
                      { dataType: "REAL", value: Math.fround(0.1) },
                      { dataType: "LREAL", value: 2 },
                      { dataType: "UINT", value: 65535 },
                      { dataType: "DINT", value: -2 },
                    ],
                  },
                ],
              },
            },
          ],
        },
        true,
      )[0],
    ).toEqual({
      line: 1,
      position: 5,
      values: [
        { text: "FALSE", dataType: "BOOL" },
        { text: "0.1", dataType: "REAL" },
        { text: "2.0", dataType: "LREAL" },
        { text: "65535", dataType: "UINT" },
        { text: "-2", dataType: "DINT" },
      ],
    });
  });
  it("hides offline values and drops missing or invalid lines without keeping old scans", () => {
    const annotated = {
      ...snapshot,
      annotations: [
        {
          pou: "Main",
          instance: "mainInstance",
          scanCount: 1,
          lines: { 1: [entry(1, 1, 1)], 99: [entry(99, 1, 1)] },
        },
      ],
    };
    expect(mapAnnotations("x", annotated, false)).toEqual([]);
    expect(mapAnnotations("x", null, true)).toEqual([]);
    expect(mapAnnotations("x", annotated, true)).toHaveLength(1);
    expect(mapAnnotations("x", snapshot, true)).toEqual([]);
  });
});

describe("source span mapping", () => {
  it("preserves multiline spans and handles CRLF without selecting the newline", () => {
    expect(spanRange("abc\r\ndefg\nhi", { line: 1, column: 2, endLine: 2, endColumn: 4 })).toEqual({
      from: 1,
      to: 8,
    });
  });
  it("clamps zero-width EOF and stale spans safely", () => {
    expect(spanRange("abc", { line: 1, column: 4, endLine: 1, endColumn: 4 })).toEqual({
      from: 3,
      to: 3,
    });
    expect(spanRange("abc", { line: 99, column: 99, endLine: 1, endColumn: 1 })).toEqual({
      from: 3,
      to: 3,
    });
  });
});

it("formats enum inline values through the assignment target descriptor and type table", async () => {
  const { compileProject } = await import("@benchtop-plc/compiler");
  const { createRuntime, VirtualClock, VirtualTicker } = await import("@benchtop-plc/runtime");
  const source = "PROGRAM Main VAR phase : State; END_VAR phase := Running; END_PROGRAM";
  const ir = compileProject([source], ["TYPE State : (Idle, Running, Done); END_TYPE"]).ir!;
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  expect(mapAnnotations(source, runtime.step(), true, ir)[0]?.values).toEqual([
    { text: "Running", dataType: "INT" },
  ]);
});

it("selects the displayed POU and omits an uninstantiated PROGRAM", async () => {
  const { compileProject } = await import("@benchtop-plc/compiler");
  const { createRuntime, VirtualClock, VirtualTicker } = await import("@benchtop-plc/runtime");
  const source = (name: string, value: number) =>
    `PROGRAM ${name} VAR n : INT; END_VAR n := ${value}; END_PROGRAM`;
  const ir = compileProject(
    [source("One", 1), source("Two", 2), source("Unused", 3)],
    [],
    "CONFIGURATION Plant RESOURCE Station ON Cpu TASK T (INTERVAL := T#10ms, PRIORITY := 0); PROGRAM A WITH T : One; PROGRAM B WITH T : Two; END_RESOURCE END_CONFIGURATION",
  ).ir!;
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  const snapshot = runtime.step();
  expect(mapAnnotations(source("Two", 2), snapshot, true, ir, "two")[0]?.values).toEqual([
    { text: "2", dataType: "INT" },
  ]);
  expect(mapAnnotations(source("Unused", 3), snapshot, true, ir, "Unused")).toEqual([]);
});

it("selects a block instance and marks retained values with their older scan", () => {
  const annotated: RuntimeSnapshot = {
    ...snapshot,
    scanCount: 5,
    annotations: [
      { pou: "Counter", instance: "mainInstance.A", scanCount: 4, lines: { 1: [entry(1, 1, 7)] } },
      { pou: "Counter", instance: "mainInstance.B", scanCount: 5, lines: { 1: [entry(1, 1, 12)] } },
    ],
  };
  expect(
    mapAnnotations("n := 7;", annotated, true, undefined, "Counter", "mainInstance.A"),
  ).toEqual([{ line: 1, position: 7, values: [{ text: "7", dataType: "INT" }], fromScan: 4 }]);
  expect(
    mapAnnotations("n := 7;", annotated, true, undefined, "Counter", "mainInstance.B")[0],
  ).not.toHaveProperty("fromScan");
  expect(mapAnnotations("n := 7;", annotated, true, undefined, "Counter", "missing")).toEqual([]);
});

it("maps method values only into their declaring source and formats function body values", async () => {
  const { compileProject } = await import("@benchtop-plc/compiler");
  const { createRuntime, VirtualClock, VirtualTicker } = await import("@benchtop-plc/runtime");
  const sources = [
    `PROGRAM Main VAR unit: Child; n: INT; END_VAR n := unit.Get(); n := F(); END_PROGRAM`,
    `CLASS Parent
METHOD PUBLIC Get: INT Get := 3; END_METHOD
END_CLASS`,
    `CLASS Child EXTENDS Parent END_CLASS`,
    `FUNCTION F: INT
F := 7;
END_FUNCTION`,
  ];
  const result = compileProject(sources);
  expect(result.diagnostics).toEqual([]);
  const ir = result.ir!;
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  runtime.watchBodies([
    { pou: "Parent", instance: "mainInstance.UNIT" },
    { pou: "F", instance: null },
  ]);
  const snapshot = runtime.step();
  expect(
    mapAnnotations(sources[1]!, snapshot, true, ir, "Parent", "mainInstance.UNIT")[0]?.values,
  ).toEqual([{ text: "3", dataType: "INT" }]);
  expect(mapAnnotations(sources[1]!, snapshot, true, ir, "Parent", "mainInstance.OTHER")).toEqual(
    [],
  );
  expect(mapAnnotations(sources[2]!, snapshot, true, ir, "Child", "mainInstance.UNIT")).toEqual([]);
  expect(mapAnnotations(sources[3]!, snapshot, true, ir, "F")[0]?.values).toEqual([
    { text: "7", dataType: "INT" },
  ]);
});

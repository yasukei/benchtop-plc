import type { CommandRejectionMessage, RuntimeSnapshot, SourceSpan } from "@benchtop-plc/core";
import { expect, it } from "vitest";

it("transports a non-fatal rejection with its command and diagnostic independently of state", () => {
  const rejection: CommandRejectionMessage = {
    type: "rejected",
    command: "write",
    diagnostic: {
      code: "runtime.write-input-mapped",
      severity: "error",
      args: { name: "button" },
    },
  };
  expect(structuredClone(rejection)).toEqual(rejection);
  expect(JSON.parse(JSON.stringify(rejection))).toEqual(rejection);
});

it("transports statement identity and final loop-call outputs without positional placeholders", () => {
  const lines = [
    "IF c THEN a := 1; END_IF; b := 2;",
    "FOR i := 1 TO 3 DO timer(IN := TRUE, PT := T#1s); END_FOR;",
  ];
  const spanFor = (line: number, statement: string): SourceSpan => {
    const column = lines[line - 1]!.indexOf(statement) + 1;
    return { line, column, endLine: line, endColumn: column + statement.length };
  };
  // Contract example: c is FALSE, and the timer call ran three times this scan.
  // Execution/aggregation is implemented in #8; this fixture pins the wire representation.
  const annotations: RuntimeSnapshot["annotations"] = {
    1: [{ span: spanFor(1, "b := 2;"), values: [{ dataType: "INT", value: 2 }] }],
    2: [
      {
        span: spanFor(2, "timer(IN := TRUE, PT := T#1s);"),
        values: [
          { dataType: "BOOL", value: false },
          { dataType: "TIME", value: 20 },
        ],
      },
    ],
  };

  for (const transported of [
    JSON.parse(JSON.stringify(annotations)),
    structuredClone(annotations),
  ]) {
    expect(transported).toStrictEqual(annotations);
    const restored = transported as RuntimeSnapshot["annotations"];
    expect(restored[1]).toHaveLength(1);
    const assignment = restored[1]![0]!;
    expect(lines[0]!.slice(assignment.span.column - 1, assignment.span.endColumn - 1)).toBe(
      "b := 2;",
    );
    expect(restored[2]).toHaveLength(1);
    expect(restored[2]![0]!.values).toStrictEqual([
      { dataType: "BOOL", value: false },
      { dataType: "TIME", value: 20 },
    ]);
  }
});

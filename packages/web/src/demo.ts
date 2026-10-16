import type { ProgramIR } from "@benchtop-plc/core";

export const demoSource = `PROGRAM BenchDemo
VAR
  scans : DINT;
END_VAR

scans := scans + 1;
END_PROGRAM`;

const span = { line: 6, column: 1, endLine: 6, endColumn: 20 };
/** A plain, structured-cloneable IR fixture; no compiler or standard library needed. */
export const demoProgram: ProgramIR = {
  kind: "program",
  name: "BenchDemo",
  span: { line: 1, column: 1, endLine: 7, endColumn: 12 },
  variables: [
    {
      kind: "scalar",
      name: "scans",
      key: "SCANS",
      dataType: "DINT",
      initialValue: 0,
      span: { line: 3, column: 3, endLine: 3, endColumn: 16 },
    },
  ],
  body: [
    {
      kind: "assignment",
      span,
      target: { kind: "variable", variable: 0, dataType: "DINT", span },
      value: {
        kind: "binary",
        operator: "+",
        dataType: "DINT",
        span,
        left: { kind: "variable", variable: 0, dataType: "DINT", span },
        right: { kind: "literal", dataType: "DINT", value: 1, span },
      },
    },
  ],
};

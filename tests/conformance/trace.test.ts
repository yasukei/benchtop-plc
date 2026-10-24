import { describe, expect, it } from "vitest";
import { parseTrace, runTrace } from "./trace.js";

const source = `PROGRAM Test
VAR
  Input AT %IX0.0 : BOOL;
  Output AT %QX0.0 : BOOL;
  Count : INT;
END_VAR
Output := Input;
Count := Count + 1;
END_PROGRAM`;
const trace = (step: Record<string, unknown>) =>
  parseTrace({
    kind: "run",
    cycleMs: 10,
    steps: [{ label: "check", expect: { "mainInstance.Count": 1 }, ...step }],
  });

describe("conformance trace harness", () => {
  it("reports case, step, variable, expected and actual values on a wrong expectation", () => {
    expect(() =>
      runTrace(
        "wrong-expectation",
        source,
        trace({ scans: 1, expect: { "mainInstance.Count": 99 } }),
      ),
    ).toThrow(
      "wrong-expectation: step 1 (check): Error: variable mainInstance.Count: expected 99, actual 1 at 10 ms (scan 1)",
    );
  });

  it("uses cyclic scans, retains mapped inputs and applies scalar sets once", () => {
    runTrace(
      "scan-order",
      source,
      parseTrace({
        kind: "run",
        cycleMs: 10,
        steps: [
          {
            label: "before first scan",
            set: { "mainInstance.Input": true, "mainInstance.Count": 5 },
            advanceMs: 9,
            expect: { "mainInstance.Count": 0, "mainInstance.Output": false },
          },
          {
            label: "first tick",
            advanceMs: 1,
            expect: { "mainInstance.Count": 6, "mainInstance.Output": true },
          },
          {
            label: "two more scans",
            scans: 2,
            expect: { "mainInstance.Count": 8, "mainInstance.Output": true },
          },
          {
            label: "case insensitive names",
            set: { "mainInstance.input": false },
            scans: 1,
            expect: { "mainInstance.count": 9, "mainInstance.output": false },
          },
        ],
      }),
    );
  });

  it("supports string values in expectations and pending writes", () => {
    runTrace(
      "text",
      "PROGRAM Text VAR inputText : STRING; outputText : STRING; END_VAR outputText := inputText; END_PROGRAM",
      parseTrace({
        kind: "run",
        cycleMs: 10,
        steps: [
          {
            label: "copy text",
            set: { "mainInstance.inputText": "123" },
            scans: 1,
            expect: { "mainInstance.outputText": "123" },
          },
        ],
      }),
    );
  });

  it.each([
    { scans: -1 },
    { scans: 0.5 },
    { scans: Number.MAX_SAFE_INTEGER + 1 },
    { advanceMs: Infinity },
    { scans: 1, advanceMs: 1 },
    { scan: 1 },
    { expect: {} },
    { expect: { "mainInstance.Count": ["1"] } },
    { set: { "mainInstance.Input": null } },
    { label: "" },
  ])("rejects malformed steps %j", (step) => {
    expect(() => trace(step)).toThrow("Step 1:");
  });

  it.each([
    { kind: "run", cycleMs: 0, steps: [] },
    { kind: "run", cycleMs: 10, steps: [] },
    { kind: "compile-error", diagnostics: [] },
    { kind: "compile-error", diagnostics: [1] },
    { kind: "compile-error", diagnostics: ["name.undeclared"], steps: [] },
    { kind: "typo" },
    null,
  ])("rejects malformed traces %j", (value) => {
    expect(() => parseTrace(value)).toThrow();
  });

  it.each(["Missing", "Count.member", "Count.extra.member"])(
    "rejects unknown expectations %s",
    (path) => {
      expect(() => runTrace("unknown", source, trace({ scans: 1, expect: { [path]: 0 } }))).toThrow(
        `Unknown variable or function block member: ${path}`,
      );
    },
  );

  it.each([{ Missing: 1 }, { "mainInstance.Output": true }, { "mainInstance.Input": 1 }])(
    "rejects invalid writes %j",
    (set) => {
      expect(() => runTrace("write", source, trace({ scans: 1, set }))).toThrow("write: step 1");
    },
  );

  it("rejects unexpected compilation failures and unexpected successful negative cases", () => {
    expect(() =>
      runTrace("compile", "PROGRAM Bad missing := 1; END_PROGRAM", trace({ scans: 1 })),
    ).toThrow('actual ["name.undeclared"]');
    const negative = parseTrace({ kind: "compile-error", diagnostics: ["name.undeclared"] });
    expect(() => runTrace("negative", source, negative)).toThrow("IR present");
    expect(() => runTrace("wrong-code", "PROGRAM Bad EXIT; END_PROGRAM", negative)).toThrow(
      'actual ["flow.exit-outside-loop"]',
    );
  });

  it("fails at the responsible step on an unexpected runtime diagnostic", () => {
    expect(() =>
      runTrace(
        "fault",
        "PROGRAM Fault VAR N : INT; END_VAR N := 1 / N; END_PROGRAM",
        trace({ scans: 1 }),
      ),
    ).toThrow(
      "fault: step 1 (check): Error: Unexpected runtime state FAULT: runtime.division-by-zero",
    );
  });
});

import { describe, expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import { parseWrittenValue, variableValue } from "./monitor.js";

describe("monitor values", () => {
  it("accepts finite typed values and TIME literals or milliseconds", () => {
    expect(parseWrittenValue("BOOL", "false")).toEqual({ dataType: "BOOL", value: false });
    expect(parseWrittenValue("INT", "-123")).toEqual({ dataType: "INT", value: -123 });
    expect(parseWrittenValue("REAL", "1.25")).toEqual({ dataType: "REAL", value: 1.25 });
    expect(parseWrittenValue("TIME", "T#1s500ms")).toEqual({ dataType: "TIME", value: 1500 });
    expect(parseWrittenValue("TIME", "1500")).toEqual({ dataType: "TIME", value: 1500 });
    expect(parseWrittenValue("TIME", "T#-1s")).toEqual({ dataType: "TIME", value: -1000 });
  });
  it("rejects invalid literals, nonfinite values and out-of-range integers", () => {
    for (const input of ["", " ", "NaN", "Infinity", "1e999", "1; x := 2"])
      expect(parseWrittenValue("LREAL", input)).toBeNull();
    expect(parseWrittenValue("BOOL", "1")).toBeNull();
    expect(parseWrittenValue("INT", "32768")).toBeNull();
    expect(parseWrittenValue("UINT", "-1")).toBeNull();
    expect(parseWrittenValue("DINT", "2147483648")).toBeNull();
    expect(parseWrittenValue("TIME", "T#garbage")).toBeNull();
    expect(parseWrittenValue("TIME", "T#1s T#2s")).toBeNull();
    expect(parseWrittenValue("TIME", "1.5")).toBeNull();
    expect(parseWrittenValue("REAL", "1e100")).toBeNull();
  });
  it("shows FB outputs with descriptor names and IEC formatting", () => {
    const variable = compile("PROGRAM Main VAR timer: TON; END_VAR END_PROGRAM").ir!.variables[0]!;
    expect(
      variableValue(variable, {
        kind: "functionBlock",
        inputs: [],
        outputs: [
          { dataType: "BOOL", value: true },
          { dataType: "TIME", value: 1250 },
        ],
      }),
    ).toBe("Q=TRUE, ET=T#1s250ms");
    expect(variableValue(variable, undefined)).toBe("—");
  });
});

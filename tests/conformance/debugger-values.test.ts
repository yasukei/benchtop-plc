import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function setup(sources: string[]) {
  const compiled = compileProject(sources);
  expect(compiled.diagnostics).toEqual([]);
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(compiled.ir!);
  return { runtime, clock };
}

const longResults = [
  ["LINT", "LINT#-9007199254740993", "-9007199254740993"],
  ["ULINT", "ULINT#18446744073709551615", "18446744073709551615"],
  ["LWORD", "LWORD#16#8000000000000001", "9223372036854775809"],
  ["LTIME", "LTIME#9007199254740993ns", "9007199254740993"],
  ["LDATE", "LDATE#1970-01-02", "86400000000000"],
  ["LTOD", "LTOD#23:59:59.999999999", "86399999999999"],
  ["LDT", "LDT#1970-04-15-05:59:59.254740993", "9007199254740993"],
] as const;

for (const call of ["function", "method", "standard"] as const) {
  it.each(longResults)(
    `serializes a completed ${call} call's %s annotation at a halt and after a scan`,
    (dataType, literal, value) => {
      const sources = [
        `PROGRAM Main
VAR ${call === "method" ? "unit : LongValue;" : ""} done : BOOL; END_VAR
${call === "function" ? "GetValue()" : call === "method" ? "unit.GetValue()" : `SEL(FALSE, ${literal}, ${literal})`};
done := TRUE;
END_PROGRAM`,
      ];
      if (call === "function")
        sources.push(`FUNCTION GetValue : ${dataType} GetValue := ${literal}; END_FUNCTION`);
      if (call === "method")
        sources.push(`CLASS LongValue
METHOD PUBLIC GetValue : ${dataType} GetValue := ${literal}; END_METHOD
END_CLASS`);
      const { runtime, clock } = setup(sources);
      const expected = { dataType, value };
      runtime.setBreakpoints([{ pou: "Main", line: 4 }]);
      runtime.run();
      clock.advance(10);
      expect(runtime.state).toBe("HALT");
      const halted = runtime.halted!;
      expect(halted.frames[0]!.annotations[3]![0]!.values).toEqual([expected]);
      expect(JSON.parse(JSON.stringify(halted))).toEqual(halted);
      const paused = runtime.snapshot();
      expect(paused.annotations[0]!.lines[3]![0]!.values).toEqual([expected]);
      expect(JSON.parse(JSON.stringify(paused))).toEqual(paused);
      runtime.continue();
      runtime.setBreakpoints([]);
      clock.advance(10);
      const completed = runtime.snapshot();
      expect(completed.scanCount).toBe(2);
      expect(completed.annotations[0]!.lines[3]![0]!.values).toEqual([expected]);
      expect(JSON.parse(JSON.stringify(completed))).toEqual(completed);
      expect(runtime.diagnostic).toBeNull();
    },
  );
}

it.each([
  ["REAL", "D", "DWORD", "16#7FC00000"],
  ["REAL", "D", "DWORD", "16#7F800000"],
  ["REAL", "D", "DWORD", "16#FF800000"],
  ["LREAL", "L", "LWORD", "16#7FF8000000000000"],
  ["LREAL", "L", "LWORD", "16#7FF0000000000000"],
  ["LREAL", "L", "LWORD", "16#FFF0000000000000"],
] as const)(
  "inspects invalid %s in-out bytes %s %s %s without a program read",
  (realType, size, bitsType, bits) => {
    const { runtime, clock } = setup([
      `PROGRAM Main
VAR bits AT %M${size}0 : ${bitsType}; r AT %M${size}0 : ${realType}; readNow : BOOL; END_VAR
bits := ${bitsType}#${bits};
Inspect(x := r, readNow := readNow);
END_PROGRAM`,
      `FUNCTION Inspect
VAR_IN_OUT x : ${realType}; END_VAR
VAR_INPUT readNow : BOOL; END_VAR
VAR copy : ${realType}; END_VAR
IF readNow THEN copy := x; END_IF;
RETURN;
END_FUNCTION`,
    ]);
    runtime.setBreakpoints([{ pou: "Inspect", line: 6 }]);
    runtime.run();
    clock.advance(10);
    expect(runtime.state).toBe("HALT");
    const halted = runtime.halted!;
    const invalid = { kind: "invalidReal", bits };
    expect(halted.frames[0]!.values).toContainEqual({
      name: "x",
      value: invalid,
      actual: { path: "mainInstance.r" },
    });
    expect(JSON.parse(JSON.stringify(halted))).toEqual(halted);
    const snapshot = runtime.snapshot();
    expect(snapshot.variables).toContainEqual(invalid);
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    runtime.continue();
    expect(runtime.state).toBe("RUN");
    expect(runtime.snapshot().scanCount).toBe(1);
    expect(runtime.diagnostic).toBeNull();
    runtime.setBreakpoints([]);
    runtime.write(2, { dataType: "BOOL", value: true });
    clock.advance(10);
    expect(runtime.state).toBe("FAULT");
    expect(runtime.diagnostic?.code).toBe("runtime.invalid-value");
  },
);

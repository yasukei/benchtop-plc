import { expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

const conversions = [
  ["REAL", "DWORD", "1.0", 1065353216],
  ["DWORD", "REAL", "16#3F800000", 1],
  ["LREAL", "LWORD", "1.0", "4607182418800017408"],
  ["LWORD", "LREAL", "16#3FF0000000000000", 1],
  ["BYTE", "BOOL", "2", false],
  ["WORD", "BOOL", "2", false],
  ["DWORD", "BOOL", "2", false],
  ["LWORD", "BOOL", "2", false],
] as const;

for (const [from, to, literal, expected] of conversions) {
  for (const overloaded of [false, true]) {
    const name = overloaded ? `TO_${to}` : `${from}_TO_${to}`;
    it.each([false, true])(
      `warns at ${name}(${from}) with a constant operand: %s and executes the result`,
      (constant) => {
        const call = `${name}(${constant ? `${from}#${literal}` : "x"})`;
        const source = `PROGRAM P\nVAR x: ${from} := ${literal}; result: ${to}; END_VAR\nresult := ${call};\nEND_PROGRAM`;
        const compiled = compile(source);
        expect(compiled.diagnostics).toEqual([
          {
            code: "type.portability",
            severity: "warning",
            args: { function: `${from}_TO_${to}` },
            span: { line: 3, column: 11, endLine: 3, endColumn: 11 + call.length },
          },
        ]);
        expect(compiled.ir).toBeDefined();
        const clock = new VirtualClock();
        const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
        runtime.load(compiled.ir!);
        const snapshot = runtime.scanOnce();
        expect(snapshot.variables[1]).toMatchObject({
          kind: "scalar",
          value: expected,
        });
      },
    );
  }
}

it("keeps warnings in folded initializers and nested calls", () => {
  const compiled = compile(`PROGRAM P
VAR b: BOOL := TO_BOOL(BYTE#2); d: DWORD; END_VAR
d := REAL_TO_DWORD(DWORD_TO_REAL(DWORD#16#3F800000));
END_PROGRAM`);
  expect(compiled.ir).toBeDefined();
  expect(
    compiled.diagnostics.map(({ code, severity, args }) => ({ code, severity, args })),
  ).toEqual(
    ["BYTE_TO_BOOL", "DWORD_TO_REAL", "REAL_TO_DWORD"].map((name) => ({
      code: "type.portability",
      severity: "warning",
      args: { function: name },
    })),
  );
});

it.each([
  ["b: BOOL;", "b := TO_BOOL(TRUE);"],
  ["d: DWORD;", "d := TO_DWORD(WORD#2);"],
  ["r: REAL;", "r := TO_REAL(INT#2);"],
  ["i: INT;", "i := REAL_TO_INT(REAL#2.5);"],
])("does not warn for other accepted conversions: %s %s", (declarations, body) => {
  const compiled = compile(`PROGRAM P VAR ${declarations} END_VAR ${body} END_PROGRAM`);
  expect(compiled.ir).toBeDefined();
  expect(compiled.diagnostics).toEqual([]);
});

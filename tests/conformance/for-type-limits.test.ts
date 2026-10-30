import { describe, expect, it } from "vitest";
import { compile } from "@benchtop-plc/compiler";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function execute(type: string, from: bigint, to: bigint, step: bigint) {
  const compiled = compile(`PROGRAM Main
    VAR i, last: ${type}; count: INT; completed: BOOL; END_VAR
    FOR i := ${from} TO ${to} BY ${step} DO
      count := count + 1;
      last := i;
    END_FOR;
    completed := TRUE;
  END_PROGRAM`);
  expect(compiled.diagnostics).toEqual([]);
  expect(compiled.ir).toBeDefined();
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(compiled.ir!);
  const snapshot = runtime.scanOnce();
  expect(runtime.diagnostic).toBeNull();
  return Object.fromEntries(
    snapshot.variables.map((cell, index) => [
      compiled.ir!.variables[index]!.name.replace(/^mainInstance\./, ""),
      cell.kind === "scalar" ? cell.value : null,
    ]),
  );
}

const signed = [
  ["SINT", -128n, 127n],
  ["INT", -32768n, 32767n],
  ["DINT", -2147483648n, 2147483647n],
  ["LINT", -9223372036854775808n, 9223372036854775807n],
] as const;
const unsigned = [
  ["USINT", 0n, 255n],
  ["UINT", 0n, 65535n],
  ["UDINT", 0n, 4294967295n],
  ["ULINT", 0n, 18446744073709551615n],
] as const;

function stored(type: string, value: bigint) {
  return type === "LINT" || type === "ULINT" ? String(value) : Number(value);
}

describe.each([...signed, ...unsigned])("FOR at %s limits", (type, _min, max) => {
  it("ends at the upper limit without wrapping", () => {
    const from = type === "USINT" ? 250n : max - 2n;
    expect(execute(type, from, max, 1n)).toEqual({
      i: stored(type, max),
      last: stored(type, max),
      count: Number(max - from + 1n),
      completed: true,
    });
  });

  it("keeps the last body value when a larger step skips over the upper limit", () => {
    expect(execute(type, max - 4n, max, 3n)).toEqual({
      i: stored(type, max - 1n),
      last: stored(type, max - 1n),
      count: 2,
      completed: true,
    });
  });
});

describe.each(signed)("FOR at %s signed limits", (type, min, max) => {
  it("ends at the lower limit without wrapping", () => {
    const from = type === "SINT" ? -127n : min + 2n;
    expect(execute(type, from, min, -1n)).toEqual({
      i: stored(type, min),
      last: stored(type, min),
      count: Number(from - min + 1n),
      completed: true,
    });
  });

  it("keeps the last body value when a larger step skips over the lower limit", () => {
    expect(execute(type, min + 4n, min, -3n)).toEqual({
      i: stored(type, min + 1n),
      last: stored(type, min + 1n),
      count: 2,
      completed: true,
    });
  });

  it("increments and then checks when counting away from either limit", () => {
    expect(execute(type, min, min + 2n, 1n)).toEqual({
      i: stored(type, min + 3n),
      last: stored(type, min + 2n),
      count: 3,
      completed: true,
    });
    expect(execute(type, max, max - 2n, -1n)).toEqual({
      i: stored(type, max - 3n),
      last: stored(type, max - 2n),
      count: 3,
      completed: true,
    });
  });
});

it.each([
  [1n, 3n, 1n, 4, 3, 3],
  [3n, 1n, -1n, 0, 1, 3],
  [1n, 6n, 2n, 7, 5, 3],
  [3n, 1n, 1n, 3, 0, 0],
])("preserves ordinary FOR %s TO %s BY %s", (from, to, step, i, last, count) => {
  expect(execute("INT", from, to, step)).toEqual({ i, last, count, completed: true });
});

import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import {
  snapshotVariable,
  parseDirectAddress,
  writeDirectValue,
  type TypedValue,
} from "@benchtop-plc/core";
import {
  createRuntime,
  VirtualClock,
  VirtualTicker,
  RuntimeCommandRejected,
} from "@benchtop-plc/runtime";

function setup(programs: string[], configuration?: string, types: string[] = []) {
  const result = compileProject(programs, types, configuration);
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(result.ir).toBeDefined();
  const ir = result.ir!;
  const clock = new VirtualClock();
  const inputs = Array<number>(64).fill(0);
  const runtime = createRuntime({
    clock,
    ticker: new VirtualTicker(clock),
    stages: { readInputs: () => inputs },
  });
  runtime.load(ir);
  const id = (name: string) => ir.variables.findIndex((v) => v.name === name);
  const value = (name: string) => snapshotVariable(runtime.snapshot(), id(name));
  const input = (address: string, value: TypedValue) =>
    writeDirectValue(inputs, parseDirectAddress(address)!, value);
  return { runtime, clock, inputs, input, id, value };
}

it("traces INT inputs and coherent overlapping input views", () => {
  const { runtime, clock, input, value } = setup([
    `PROGRAM Main VAR
    sample AT %IW0 : INT; bit0 AT %IX0.0 : BOOL; low AT %IB0 : BYTE; high AT %IB1 : BYTE;
    copy : INT; flag : BOOL; END_VAR copy := sample; flag := bit0; END_PROGRAM`,
  ]);
  runtime.run();
  for (const [n, low, high, bit] of [
    [-5, 251, 255, true],
    [258, 2, 1, false],
    [0, 0, 0, false],
  ] as const) {
    input("%IW0", { dataType: "INT", value: n });
    clock.advance(10);
    expect(value("mainInstance.copy")).toMatchObject({ value: n });
    expect(value("mainInstance.low")).toMatchObject({ value: low });
    expect(value("mainInstance.high")).toMatchObject({ value: high });
    expect(value("mainInstance.flag")).toMatchObject({ value: bit });
  }
});
it("traces two programs sharing memory bytes immediately and zeroes memory on cold reset/load", () => {
  const { runtime, clock, value, id } = setup(
    [
      "PROGRAM Writer VAR shared AT %MW1 : INT := 16#0102; END_VAR shared := shared + 1; END_PROGRAM",
      "PROGRAM Reader VAR shared AT %MW1 : INT; low AT %MB2 : BYTE; high AT %MB3 : BYTE; copy : INT; END_VAR copy := shared; END_PROGRAM",
    ],
    `CONFIGURATION Plant VAR_GLOBAL seed AT %MB10 : BYTE := 7; END_VAR
    RESOURCE Station ON Cpu VAR_GLOBAL later AT %MW1 : WORD := 99; END_VAR
    TASK T (INTERVAL := T#10ms, PRIORITY := 1); PROGRAM A WITH T : Writer; PROGRAM B WITH T : Reader;
    END_RESOURCE END_CONFIGURATION`,
  );
  expect(value("B.shared")).toMatchObject({ value: 258 });
  runtime.run();
  for (const n of [259, 260, 261]) {
    clock.advance(10);
    expect(value("B.copy")).toMatchObject({ value: n });
    expect(value("B.low")).toMatchObject({ value: n - 256 });
    expect(value("B.high")).toMatchObject({ value: 1 });
  }
  runtime.write(id("seed"), { dataType: "BYTE", value: 100 });
  clock.advance(10);
  runtime.coldReset();
  expect(value("B.shared")).toMatchObject({ value: 258 });
  expect(value("seed")).toMatchObject({ value: 7 });
  expect(value("B.copy")).toMatchObject({ value: 0 });
});
for (const [realType, size, bitsType, bits, pattern] of [
  ["REAL", "D", "DWORD", 0x7fc00000, "16#7FC00000"],
  ["REAL", "D", "DWORD", 0x7f800000, "16#7F800000"],
  ["LREAL", "L", "LWORD", "9218868437227405312", "16#7FF0000000000000"],
] as const) {
  it(`faults only when reading invalid ${realType} bytes (${pattern}) and snapshots never throw`, () => {
    const { runtime, clock, value, id } = setup([
      `PROGRAM Main VAR
      bits AT %M${size}0 : ${bitsType}; sample AT %M${size}0 : ${realType};
      readNow : BOOL; copy : ${realType}; END_VAR
      bits := ${bitsType}#${bits}; IF readNow THEN copy := sample; END_IF; END_PROGRAM`,
    ]);
    runtime.run();
    clock.advance(10);
    expect(runtime.state).toBe("RUN");
    expect(value("mainInstance.sample")).toEqual({ kind: "invalidReal", bits: pattern });
    expect(() => runtime.snapshot()).not.toThrow();
    runtime.write(id("mainInstance.readNow"), { dataType: "BOOL", value: true });
    clock.advance(10);
    expect(runtime.state).toBe("FAULT");
    expect(runtime.diagnostic).toMatchObject({ code: "runtime.invalid-value", pou: "Main" });
    expect(value("mainInstance.sample")).toEqual({ kind: "invalidReal", bits: pattern });
    runtime.write(id("mainInstance.sample"), { dataType: realType, value: 1.5 });
    expect(value("mainInstance.sample")).toMatchObject({ kind: "scalar", value: 1.5 });
  });
}
it("faults on a non-finite REAL input connection at the configuration declaration", () => {
  const { runtime, input, value } = setup(
    [
      "PROGRAM Main VAR_INPUT sample : REAL; END_VAR VAR ran : BOOL; END_VAR ran := TRUE; END_PROGRAM",
    ],
    `CONFIGURATION Plant RESOURCE Station ON Cpu TASK T (INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM A WITH T : Main (sample := %ID0); END_RESOURCE END_CONFIGURATION`,
  );
  input("%ID0", { dataType: "DWORD", value: 0x7fc00000 });
  expect(() => runtime.step()).not.toThrow();
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic).toMatchObject({
    code: "runtime.invalid-value",
    sourceKind: "configuration",
    pou: "Plant",
    instance: "A",
  });
  expect(value("A.ran")).toMatchObject({ value: false });
});
it("copies typed address connections with little-endian numbering", () => {
  const { runtime, input, value, clock } = setup(
    [
      "PROGRAM Main VAR_INPUT sample : INT; END_VAR VAR_OUTPUT result : INT; END_VAR result := sample + 1; END_PROGRAM",
      "PROGRAM Reader VAR view AT %MW10 : WORD; copy : WORD; END_VAR copy := view; END_PROGRAM",
    ],
    `CONFIGURATION Plant RESOURCE Station ON Cpu TASK T (INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM A WITH T : Main (sample := %IW31, result => %MW10); PROGRAM B WITH T : Reader;
    END_RESOURCE END_CONFIGURATION`,
  );
  input("%IW31", { dataType: "INT", value: -5 });
  runtime.run();
  clock.advance(10);
  expect(value("A.sample")).toMatchObject({ value: -5 });
  expect(value("B.copy")).toMatchObject({ value: 65532 });
});
it("zeros all output bytes outside RUN, even unbound connections, and blocks monitor input writes", () => {
  const { runtime, clock, id } = setup(
    [
      `PROGRAM Main VAR_INPUT sample : INT; END_VAR VAR_OUTPUT out : LWORD; END_VAR
      VAR input AT %IW31 : INT; END_VAR out := LWORD#16#FFFFFFFFFFFFFFFF; END_PROGRAM`,
    ],
    `CONFIGURATION Plant RESOURCE Station ON Cpu TASK T (INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM A WITH T : Main (out => %QL7); END_RESOURCE END_CONFIGURATION`,
  );
  expect(() => runtime.write(id("A.input"), { dataType: "INT", value: 3 })).toThrow(
    RuntimeCommandRejected,
  );
  runtime.step();
  expect(runtime.snapshot().outputs).toEqual(Array<number>(64).fill(0));
  runtime.run();
  clock.advance(10);
  expect(runtime.snapshot().outputs.slice(56)).toEqual(Array<number>(8).fill(255));
  for (const stop of [
    () => runtime.stop(),
    () => runtime.setEmergencyStop(true),
    () => runtime.coldReset(),
  ]) {
    stop();
    expect(runtime.snapshot().outputs).toEqual(Array<number>(64).fill(0));
    runtime.setEmergencyStop(false);
    runtime.run();
    clock.advance(10);
  }
});
it("keeps aliases, references, forces and VAR_IN_OUT bound to the same located bytes", () => {
  const { runtime, clock, value, id } = setup(
    [
      `PROGRAM Main VAR shared AT %MW0 : Sample; low AT %MB0 : BYTE; pointer : REF_TO Sample; END_VAR
      pointer := REF(shared); pointer^ := 16#0102; Modify(v := shared); END_PROGRAM`,
      "FUNCTION Modify VAR_IN_OUT v : Sample; END_VAR v := v + 1; END_FUNCTION",
    ],
    undefined,
    ["TYPE Sample : INT; END_TYPE"],
  );
  runtime.run();
  clock.advance(10);
  expect(value("mainInstance.low")).toMatchObject({ value: 3 });
  runtime.force(id("mainInstance.low"), { dataType: "BYTE", value: 7 });
  clock.advance(10);
  expect(value("mainInstance.shared")).toMatchObject({ value: 263 });
});

const overlappingForceProgram = `PROGRAM Main VAR
  wide AT %MW0 : WORD; low AT %MB0 : BYTE; seen : WORD;
  END_VAR seen := wide; END_PROGRAM`;

it.each([false, true])(
  "applies overlapping forces in last-set order and promotes re-forces (byte first: %s)",
  (byteFirst) => {
    const { runtime, clock, value, id } = setup([overlappingForceProgram]);
    const wide = id("mainInstance.wide"),
      low = id("mainInstance.low");
    const setWord = () => runtime.force(wide, { dataType: "WORD", value: 0x1234 });
    const setByte = () => runtime.force(low, { dataType: "BYTE", value: 0xff });
    const first = byteFirst ? setByte : setWord;
    const last = byteFirst ? setWord : setByte;
    const check = (expected: number) => {
      clock.advance(10);
      expect(value("mainInstance.wide")).toMatchObject({ value: expected });
      expect(value("mainInstance.low")).toMatchObject({ value: expected & 0xff });
      expect(value("mainInstance.seen")).toMatchObject({ value: expected });
      expect(runtime.snapshot().forced).toEqual([wide, low].sort((a, b) => a - b));
    };
    first();
    last();
    runtime.run();
    check(byteFirst ? 0x1234 : 0x12ff);
    // Setting the same value again still makes this the newest force.
    first();
    check(byteFirst ? 0x12ff : 0x1234);
    last();
    check(byteFirst ? 0x1234 : 0x12ff);
  },
);

for (const byteFirst of [false, true]) {
  it.each(["wide", "low"] as const)(
    `reapplies the remaining overlapping force after releasing %s (byte first: ${byteFirst})`,
    (released) => {
      const { runtime, clock, value, id } = setup([overlappingForceProgram]);
      const wide = id("mainInstance.wide"),
        low = id("mainInstance.low");
      const forces = [
        () => runtime.force(wide, { dataType: "WORD", value: 0x1234 }),
        () => runtime.force(low, { dataType: "BYTE", value: 0xff }),
      ];
      for (const set of byteFirst ? [...forces].reverse() : forces) set();
      runtime.run();
      clock.advance(10);
      const before = byteFirst ? 0x1234 : 0x12ff;
      expect(value("mainInstance.wide")).toMatchObject({ value: before });
      runtime.force(id(`mainInstance.${released}`), null);
      expect(runtime.snapshot().forced).toEqual([released === "wide" ? low : wide]);
      // Release changes the force set immediately, but bytes only at a force stage.
      expect(value("mainInstance.wide")).toMatchObject({ value: before });
      clock.advance(10);
      const remaining = released === "wide" ? 0x12ff : 0x1234;
      expect(value("mainInstance.wide")).toMatchObject({ value: remaining });
      expect(value("mainInstance.seen")).toMatchObject({ value: remaining });
      // Uncovered bytes retain their value until the program, image or a write changes them.
      runtime.write(wide, { dataType: "WORD", value: 0 });
      clock.advance(10);
      const afterWrite = released === "wide" ? 0x00ff : 0x1234;
      expect(value("mainInstance.wide")).toMatchObject({ value: afterWrite });
      expect(value("mainInstance.seen")).toMatchObject({ value: afterWrite });
    },
  );
}

it("keeps overlapping force values and precedence unchanged after an invalid re-force", () => {
  const { runtime, id, value } = setup([overlappingForceProgram]);
  runtime.force(id("mainInstance.low"), { dataType: "BYTE", value: 0xff });
  runtime.force(id("mainInstance.wide"), { dataType: "WORD", value: 0x1234 });
  expect(() => runtime.force(id("mainInstance.low"), { dataType: "BYTE", value: 256 })).toThrow(
    RuntimeCommandRejected,
  );
  runtime.step();
  expect(value("mainInstance.wide")).toMatchObject({ value: 0x1234 });
  expect(runtime.snapshot().forced).toHaveLength(2);
});

it("overrides only the addressed bit when the newest force overlaps a byte", () => {
  const { runtime, id, value } = setup([
    `PROGRAM Main VAR lowByte AT %MB0 : BYTE; bit0 AT %MX0.0 : BOOL;
    END_VAR END_PROGRAM`,
  ]);
  runtime.force(id("mainInstance.lowByte"), { dataType: "BYTE", value: 0xaa });
  runtime.force(id("mainInstance.bit0"), { dataType: "BOOL", value: true });
  runtime.step();
  expect(value("mainInstance.lowByte")).toMatchObject({ value: 0xab });
  runtime.force(id("mainInstance.lowByte"), { dataType: "BYTE", value: 0xaa });
  runtime.step();
  expect(value("mainInstance.lowByte")).toMatchObject({ value: 0xaa });
  expect(value("mainInstance.bit0")).toMatchObject({ value: false });
});

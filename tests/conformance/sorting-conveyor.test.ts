import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import {
  parseDirectAddress,
  readDirectValue,
  snapshotVariable,
  writeDirectValue,
  type IoImage,
} from "@benchtop-plc/core";
import { readProject, writeProject } from "@benchtop-plc/project";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

const read = (name: string) =>
  readFileSync(new URL(`../../examples/sorting-conveyor/${name}`, import.meta.url), "utf8");
const sources = [
  "iactuator.st",
  "main.st",
  "actuator.st",
  "conveyor-motor.st",
  "diverter.st",
  "is-actuator-active.st",
  "part-counter.st",
].map(read);
const original = readProject(read("project.xml"));

it("preserves every sorting conveyor source and panel on save/reopen", () => {
  expect(original.diagnostics).toEqual([]);
  expect(original.value!.pous).toEqual(sources);
  const saved = writeProject(original.value!);
  expect(saved.diagnostics).toEqual([]);
  expect(readProject(saved.value!)).toEqual(original);
});

it.each(["source", "xml", "reopened"])(
  "traces sorting, dynamic binding and retained totals from %s",
  (input) => {
    const project =
      input === "reopened"
        ? readProject(writeProject(original.value!).value!).value!
        : original.value!;
    const compiled = compileProject(input === "source" ? sources : project.pous, project.dataTypes);
    expect(compiled.diagnostics).toEqual([]);
    const ir = compiled.ir!;
    const clock = new VirtualClock();
    const inputs: IoImage = Array<number>(64).fill(0);
    const runtime = createRuntime({
      clock,
      ticker: new VirtualTicker(clock),
      stages: { readInputs: () => [...inputs] },
    });
    runtime.load(ir);
    runtime.watch(ir.variables.map((_, id) => id));
    const id = (name: string) =>
      ir.variables.findIndex((v) => v.key === `MAININSTANCE.${name.toUpperCase()}`);
    const value = (name: string) => snapshotVariable(runtime.snapshot(), id(name));
    const bit = (address: string, value: boolean) =>
      writeDirectValue(inputs, parseDirectAddress(address)!, { dataType: "BOOL", value });
    const output = (address: string, type: "BOOL" | "UINT") =>
      readDirectValue(runtime.snapshot().outputs, parseDirectAddress(address)!, type);
    const trace = (label: string, scans: number, expected: Record<string, number | boolean>) => {
      clock.advance(scans * 10);
      expect(runtime.state, label).toBe("RUN");
      expect(runtime.diagnostic, label).toBeNull();
      for (const [name, expectedValue] of Object.entries(expected))
        expect(value(name), `${label}: ${name}`).toMatchObject({ value: expectedValue });
    };
    runtime.run();
    trace("idle primes input edges", 1, { MotorOn: false, BinATotal: 0, BinBTotal: 0 });
    bit("%IX0.2", true);
    trace("sensor while stopped does not count", 1, { DivertA: false, BinATotal: 0 });
    bit("%IX0.0", true);
    trace("START runs belt without recounting held sensor", 1, {
      MotorOn: true,
      DivertA: true,
      DivertB: false,
      "Belt.SpeedPercent": 100,
      "GateA.AngleDegrees": 90,
      "GateB.AngleDegrees": 0,
      BinATotal: 0,
    });
    for (const [index, target] of ["BELT", "GATEA", "GATEB"].entries())
      expect(value(`Actuators[${index + 1}]`)).toEqual({
        kind: "reference",
        target: `mainInstance.${target}`,
      });
    bit("%IX0.0", false);
    bit("%IX0.2", false);
    trace("release sensor retracts diverter, motor stays latched", 1, {
      MotorOn: true,
      DivertA: false,
      "GateA.AngleDegrees": 0,
    });
    bit("%IX0.2", true);
    trace("part A goes only to bin A", 1, {
      DivertA: true,
      DivertB: false,
      BinATotal: 1,
      BinBTotal: 0,
    });
    expect(output("%QX0.0", "BOOL")).toBe(true);
    expect(output("%QX0.1", "BOOL")).toBe(true);
    expect(output("%QX0.2", "BOOL")).toBe(false);
    expect(output("%QW1", "UINT")).toBe(1);
    trace("held sensor counts once", 5, { BinATotal: 1 });
    bit("%IX0.2", false);
    bit("%IX0.3", true);
    trace("part B goes only to bin B", 1, {
      DivertA: false,
      DivertB: true,
      BinATotal: 1,
      BinBTotal: 1,
    });
    expect(output("%QW2", "UINT")).toBe(1);
    bit("%IX0.3", false);
    trace("release both sensors", 1, { DivertA: false, DivertB: false });
    bit("%IX0.2", true);
    bit("%IX0.3", true);
    trace("two simultaneous parts count independently", 1, {
      DivertA: true,
      DivertB: true,
      BinATotal: 2,
      BinBTotal: 2,
    });
    bit("%IX0.0", true);
    bit("%IX0.1", true);
    trace("STOP wins START and clears all actuators", 1, {
      MotorOn: false,
      DivertA: false,
      DivertB: false,
      "Belt.SpeedPercent": 0,
      "GateA.AngleDegrees": 0,
      "GateB.AngleDegrees": 0,
      BinATotal: 2,
      BinBTotal: 2,
    });
    bit("%IX0.1", false);
    trace("held START cannot bypass stop", 1, { Running: false });
    runtime.warmRestart();
    expect(runtime.state).toBe("STOP");
    expect(value("BinA.Parts")).toMatchObject({ value: 2 });
    expect(value("BinB.Parts")).toMatchObject({ value: 2 });
    expect(value("Running")).toMatchObject({ value: false });
    for (const index of [1, 2, 3])
      expect(value(`Actuators[${index}]`)).toEqual({ kind: "reference", target: null });
    expect(runtime.snapshot().outputs.every((byte) => byte === 0)).toBe(true);
    runtime.run();
    trace("warm restart republishes totals without starting or recounting held inputs", 1, {
      MotorOn: false,
      DivertA: false,
      DivertB: false,
      BinATotal: 2,
      BinBTotal: 2,
    });
    expect(output("%QW1", "UINT")).toBe(2);
    expect(output("%QW2", "UINT")).toBe(2);
    bit("%IX0.0", false);
    bit("%IX0.2", false);
    bit("%IX0.3", false);
    trace("release controls after restart", 1, { Running: false });
    bit("%IX0.0", true);
    trace("fresh START rebinds and runs the motor", 1, { MotorOn: true });
    bit("%IX0.2", true);
    trace("count continues from retained total", 1, { BinATotal: 3, BinBTotal: 2 });
    runtime.write(id("BinA.Parts"), { dataType: "UINT", value: 65535 });
    bit("%IX0.2", false);
    trace("full bin", 1, { BinATotal: 65535 });
    bit("%IX0.2", true);
    trace("counter saturates", 1, { BinATotal: 65535, MotorOn: true });
    bit("%IX0.2", false);
    bit("%IX0.3", false);
    trace("release before reset", 1, { BinBTotal: 2 });
    bit("%IX0.4", true);
    bit("%IX0.3", true);
    trace("RESET wins a simultaneous part edge", 1, { BinATotal: 0, BinBTotal: 0 });
    bit("%IX0.4", false);
    trace("held part after reset is not counted again", 1, { BinBTotal: 0 });
    bit("%IX0.3", false);
    trace("release part", 1, { BinBTotal: 0 });
    bit("%IX0.3", true);
    trace("fresh part after reset", 1, { BinBTotal: 1 });
    runtime.coldReset();
    expect(value("BinA.Parts")).toMatchObject({ value: 0 });
    expect(value("BinB.Parts")).toMatchObject({ value: 0 });
  },
);

import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import {
  readDirectValue,
  parseDirectAddress,
  snapshotVariable,
  writeDirectValue,
  type IoImage,
  type TypedValue,
} from "@benchtop-plc/core";
import { readProject, writeProject } from "@benchtop-plc/project";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

const read = (name: string) =>
  readFileSync(new URL(`../../examples/tank-station/${name}`, import.meta.url), "utf8");
const original = readProject(read("project.xml"));

it("preserves every tank station source and panel on save/reopen", () => {
  expect(original.diagnostics).toEqual([]);
  const project = original.value!;
  expect(project.configurationSource).toBe(read("station.config.st"));
  expect(project.pous).toEqual(
    ["tank-control.st", "station-statistics.st", "acknowledge.st"].map(read),
  );
  const saved = writeProject(project);
  expect(saved.diagnostics).toEqual([]);
  expect(readProject(saved.value!)).toEqual(original);
});

it.each(["source", "xml", "reopened"])(
  "traces both tanks, task ratio, alarm events and retained run time from %s",
  (input) => {
    const project =
      input === "reopened"
        ? readProject(writeProject(original.value!).value!).value!
        : original.value!;
    const compiled = compileProject(
      input === "source"
        ? ["tank-control.st", "station-statistics.st", "acknowledge.st"].map(read)
        : project.pous,
      project.dataTypes,
      input === "source" ? read("station.config.st") : project.configurationSource,
    );
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
    const set = (address: string, value: TypedValue) =>
      writeDirectValue(inputs, parseDirectAddress(address)!, value);
    const bit = (address: string, value: boolean) => set(address, { dataType: "BOOL", value });
    const word = (address: string, value: number) => set(address, { dataType: "INT", value });
    const value = (name: string) =>
      snapshotVariable(
        runtime.snapshot(),
        ir.variables.findIndex((v) => v.key === name.toUpperCase()),
      );
    const trace = (label: string, ms: number, expected: Record<string, number | boolean>) => {
      clock.advance(ms);
      expect(runtime.state, label).toBe("RUN");
      for (const [name, expectedValue] of Object.entries(expected))
        expect(value(name), `${label}: ${name}`).toMatchObject({ value: expectedValue });
    };
    const output = (address: string, type: "BOOL" | "UINT") =>
      readDirectValue(runtime.snapshot().outputs, parseDirectAddress(address)!, type);

    word("%IW1", 20);
    word("%IW2", 60);
    word("%IW3", 50);
    runtime.run();
    trace("idle primes both start edges", 100, { "Tank1.Pump": false, "Tank2.Pump": false });
    bit("%IX0.0", true);
    bit("%IX0.2", true);
    trace("shared setpoint, independent levels", 100, {
      "Tank1.Pump": true,
      "Tank2.Pump": false,
      "Tank1.RunTicks": 1,
      "Tank2.RunTicks": 0,
    });
    bit("%IX0.0", false);
    bit("%IX0.2", false);
    trace("five fast runs for one statistics run", 300, {
      "Tank1.RunTicks": 4,
      "Tank2.RunTicks": 0,
      "Stats.Samples": 1,
      "Stats.ActivePumps": 1,
      gPumpBits: 1,
    });
    expect(runtime.snapshot().tasks.map((task) => task.runCount)).toEqual([5, 1, 0]);
    expect(output("%QW1", "UINT")).toBe(4);
    expect(output("%QW2", "UINT")).toBe(0);
    expect(output("%QW3", "UINT")).toBe(1);
    word("%IW1", 50);
    word("%IW2", 10);
    trace("tank one reaches setpoint, tank two fills", 100, {
      "Tank1.Pump": false,
      "Tank2.Pump": true,
      "Tank1.RunTicks": 4,
      "Tank2.RunTicks": 1,
    });
    word("%IW3", 70);
    trace("one global setpoint changes both controllers", 100, {
      "Tank1.Pump": true,
      "Tank2.Pump": true,
      "Tank1.RunTicks": 5,
      "Tank2.RunTicks": 2,
    });
    bit("%IX0.1", true);
    bit("%IX0.0", true);
    word("%IW2", 90);
    trace("stop wins start and high limit trips tank two", 100, {
      "Tank1.Pump": false,
      "Tank2.Pump": false,
      "Tank2.Alarm": true,
      "Tank1.RunTicks": 5,
      "Tank2.RunTicks": 2,
    });
    bit("%IX0.1", false);
    trace("held start cannot bypass stop", 100, { "Tank1.Pump": false });
    bit("%IX0.4", true);
    trace("acknowledge cannot clear an unsafe level", 100, {
      gAckCount: 1,
      "Tank2.Alarm": true,
      "Stats.ActivePumps": 0,
      "Stats.Samples": 2,
    });
    word("%IW2", 10);
    trace("held acknowledge does not repeat after level becomes safe", 100, {
      gAckCount: 1,
      "Tank2.Alarm": true,
    });
    bit("%IX0.4", false);
    bit("%IX0.0", false);
    trace("release controls", 100, { "Tank2.Alarm": true });
    bit("%IX0.4", true);
    trace("fresh acknowledge edge clears safe alarm without restarting", 100, {
      gAckCount: 2,
      "Tank2.Alarm": false,
      "Tank2.Pump": false,
    });
    expect(runtime.snapshot().tasks.map((task) => task.runCount)).toEqual([13, 2, 2]);
    bit("%IX0.4", false);
    bit("%IX0.0", true);
    bit("%IX0.2", true);
    trace("restart both tanks", 100, { "Tank1.RunTicks": 6, "Tank2.RunTicks": 3 });
    bit("%IX0.0", false);
    bit("%IX0.2", false);
    bit("%IX0.1", true);
    trace("shared stop disarms both tanks", 100, {
      "Tank1.Pump": false,
      "Tank2.Pump": false,
      "Tank1.RunTicks": 6,
      "Tank2.RunTicks": 3,
    });
    bit("%IX0.1", false);
    runtime.warmRestart();
    expect(runtime.state).toBe("STOP");
    expect(value("Tank1.RunTicks")).toMatchObject({ value: 6 });
    expect(value("Tank2.RunTicks")).toMatchObject({ value: 3 });
    expect(value("Stats.Samples")).toMatchObject({ value: 0 });
    expect(value("gPumpBits")).toMatchObject({ value: 0 });
    expect(runtime.snapshot().outputs.every((byte) => byte === 0)).toBe(true);
    expect(runtime.snapshot().tasks.every((task) => task.runCount === 0)).toBe(true);
    runtime.run();
    trace("warm restart disarms pumps and republishes counters", 100, {
      "Tank1.Enabled": false,
      "Tank2.Enabled": false,
      "Tank1.RunTime": 6,
      "Tank2.RunTime": 3,
    });
    expect(output("%QX0.0", "BOOL")).toBe(false);
    expect(output("%QX0.2", "BOOL")).toBe(false);
    expect(output("%QW1", "UINT")).toBe(6);
    expect(output("%QW2", "UINT")).toBe(3);
    bit("%IX0.0", true);
    bit("%IX0.2", true);
    trace("counting continues from retained values", 100, {
      "Tank1.RunTicks": 7,
      "Tank2.RunTicks": 4,
    });
    runtime.write(
      ir.variables.findIndex((v) => v.key === "TANK1.RUNTICKS"),
      { dataType: "UINT", value: 65534 },
    );
    trace("word counter saturates without stopping the pump", 300, {
      "Tank1.Pump": true,
      "Tank1.RunTicks": 65535,
      "Tank1.RunTime": 65535,
      "Tank2.RunTicks": 7,
    });
    runtime.stop();
    const records = JSON.parse(JSON.stringify(runtime.retentiveRecords()));
    expect(records).toHaveLength(2);
    runtime.load(ir);
    expect(runtime.restoreRetentive(records)).toEqual([]);
    expect(value("Tank1.RunTicks")).toMatchObject({ value: 65535 });
    expect(value("Tank2.RunTicks")).toMatchObject({ value: 7 });
    runtime.coldReset();
    expect(value("Tank1.RunTicks")).toMatchObject({ value: 0 });
    expect(value("Tank2.RunTicks")).toMatchObject({ value: 0 });
  },
);

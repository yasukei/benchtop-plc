import { expect, it } from "vitest";
import { compileProject } from "@benchtop-plc/compiler";
import { snapshotVariable, type RetentiveRecord } from "@benchtop-plc/core";
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

function setup(source: string) {
  const result = compileProject([source]);
  expect(result.diagnostics).toEqual([]);
  const ir = result.ir!;
  const clock = new VirtualClock();
  const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
  runtime.load(ir);
  const id = (name: string) =>
    ir.variables.findIndex((v) => v.name.toUpperCase() === `MAININSTANCE.${name.toUpperCase()}`);
  const cell = (name: string) => snapshotVariable(runtime.snapshot(), id(name));
  return { runtime, clock, id, cell };
}

it("traces RETAIN and NON_RETAIN counters through resume, warm restart and cold reset", () => {
  const { runtime, clock, cell } = setup(
    `PROGRAM P VAR RETAIN kept : INT := 5; END_VAR VAR NON_RETAIN reset : INT := 2; END_VAR kept := kept + 1; reset := reset + 1; END_PROGRAM`,
  );
  runtime.run();
  clock.advance(30);
  runtime.stop();
  expect(cell("kept")).toMatchObject({ value: 8 });
  expect(cell("reset")).toMatchObject({ value: 5 });
  runtime.run();
  clock.advance(10);
  runtime.warmRestart();
  expect(runtime.state).toBe("STOP");
  expect(cell("kept")).toMatchObject({ value: 9 });
  expect(cell("reset")).toMatchObject({ value: 2 });
  expect(runtime.snapshot()).toMatchObject({ scanCount: 0, tasks: [{ runCount: 0, overruns: 0 }] });
  runtime.step();
  expect(cell("kept")).toMatchObject({ value: 10 });
  expect(cell("reset")).toMatchObject({ value: 3 });
  runtime.coldReset();
  expect(cell("kept")).toMatchObject({ value: 5 });
  expect(cell("reset")).toMatchObject({ value: 2 });
});

it("keeps a retained CTU's ports and CU history across warm restart and reload", () => {
  const source = `PROGRAM P VAR RETAIN ctr : CTU; END_VAR ctr(CU := TRUE, R := FALSE, PV := 10); END_PROGRAM`;
  const { runtime, cell } = setup(source);
  runtime.step();
  expect(cell("ctr")).toMatchObject({ outputs: [{ value: false }, { value: 1 }] });
  runtime.warmRestart();
  runtime.step();
  expect(cell("ctr")).toMatchObject({ outputs: [{ value: false }, { value: 1 }] });
  const saved = JSON.parse(JSON.stringify(runtime.retentiveRecords()));
  expect(saved).toHaveLength(1);
  const reloaded = setup(source);
  expect(reloaded.runtime.restoreRetentive(saved)).toEqual([]);
  expect(reloaded.runtime.state).toBe("STOP");
  reloaded.runtime.step();
  expect(reloaded.cell("ctr")).toMatchObject({ outputs: [{ value: false }, { value: 1 }] });
  runtime.coldReset();
  runtime.step();
  expect(cell("ctr")).toMatchObject({ outputs: [{ value: false }, { value: 1 }] });
});

it("acknowledges division by zero into STOP, keeps retained data, and never resumes directly from FAULT", () => {
  const { runtime, clock, cell } = setup(
    `PROGRAM P VAR RETAIN kept : INT; END_VAR VAR denominator : INT; result : INT; END_VAR kept := kept + 1; result := 10 / denominator; END_PROGRAM`,
  );
  runtime.run();
  clock.advance(10);
  expect(runtime.state).toBe("FAULT");
  expect(runtime.diagnostic?.code).toBe("runtime.division-by-zero");
  runtime.run();
  runtime.step();
  clock.advance(50);
  expect(runtime.state).toBe("FAULT");
  expect(cell("kept")).toMatchObject({ value: 1 });
  runtime.warmRestart();
  expect(runtime.state).toBe("STOP");
  expect(runtime.diagnostic).toBeNull();
  expect(cell("kept")).toMatchObject({ value: 1 });
  runtime.coldReset();
  expect(cell("kept")).toMatchObject({ value: 0 });
});

it("clears forces, pending writes, references, timers and %M, including under emergency stop", () => {
  const { runtime, clock, id, cell } = setup(
    `PROGRAM P VAR RETAIN kept : INT; timer : TON; ptr : REF_TO INT; END_VAR VAR mem AT %MW0 : INT; END_VAR kept := kept + 1; mem := 10; ptr := REF(kept); timer(IN := TRUE, PT := T#20ms); END_PROGRAM`,
  );
  runtime.run();
  clock.advance(40);
  expect(cell("timer")).toMatchObject({ outputs: [{ value: true }, { value: 20 }] });
  runtime.force(id("kept"), { dataType: "INT", value: 20 });
  runtime.write(id("kept"), { dataType: "INT", value: 100 });
  runtime.setEmergencyStop(true);
  runtime.warmRestart();
  expect(runtime.state).toBe("ESTOP");
  runtime.setEmergencyStop(false);
  expect(runtime.state).toBe("STOP");
  expect(runtime.snapshot().forced).toEqual([]);
  expect(cell("kept")).toMatchObject({ value: 4 });
  expect(cell("mem")).toMatchObject({ value: 0 });
  expect(cell("ptr")).toEqual({ kind: "reference", target: null });
  expect(cell("timer")).toMatchObject({
    inputs: [{ value: false }, { value: 0 }],
    outputs: [{ value: false }, { value: 0 }],
  });
  expect(runtime.retentiveRecords().map((r) => r.path)).toEqual(["mainInstance.kept"]);
  runtime.step();
  expect(cell("kept")).toMatchObject({ value: 5 });
  expect(cell("timer")).toMatchObject({ outputs: [{ value: false }, { value: 0 }] });
});

it.each(["R_TRIG", "F_TRIG"])(
  "%s keeps M only for retained instances across warm restart and reload",
  (type) => {
    const input = type === "R_TRIG";
    const source = `PROGRAM P
      VAR RETAIN kept : ${type}; END_VAR
      VAR ordinary : ${type}; END_VAR
      VAR NON_RETAIN explicit : ${type}; END_VAR
      kept(CLK := ${input}); ordinary(CLK := ${input}); explicit(CLK := ${input});
      END_PROGRAM`;
    const { runtime, cell } = setup(source);
    const expectQ = (name: string, value: boolean) =>
      expect(cell(name)).toMatchObject({ outputs: [{ value }] });
    runtime.step();
    for (const name of ["kept", "ordinary", "explicit"]) expectQ(name, true);
    runtime.step();
    for (const name of ["kept", "ordinary", "explicit"]) expectQ(name, false);
    runtime.stop();
    runtime.step();
    expectQ("ordinary", false);
    runtime.warmRestart();
    runtime.step();
    expectQ("kept", false);
    expectQ("ordinary", true);
    expectQ("explicit", true);
    const saved = JSON.parse(JSON.stringify(runtime.retentiveRecords())) as RetentiveRecord[];
    expect(saved).toHaveLength(1);
    const reloaded = setup(source);
    expect(reloaded.runtime.restoreRetentive(saved)).toEqual([]);
    reloaded.runtime.step();
    expect(reloaded.cell("kept")).toMatchObject({ outputs: [{ value: false }] });
    expect(reloaded.cell("ordinary")).toMatchObject({ outputs: [{ value: true }] });
    expect(reloaded.cell("explicit")).toMatchObject({ outputs: [{ value: true }] });
    runtime.coldReset();
    runtime.step();
    for (const name of ["kept", "ordinary", "explicit"]) expectQ(name, true);
    runtime.load(compileProject([source]).ir!);
    runtime.step();
    for (const name of ["kept", "ordinary", "explicit"]) expectQ(name, true);
  },
);

it.each(["R_TRIG", "F_TRIG"])(
  "%s restores a 0.8.0 previous:null record as initial M without skipped paths",
  (type) => {
    const input = type === "R_TRIG";
    const source = `PROGRAM P VAR RETAIN edge : ${type}; END_VAR
      edge(CLK := ${input}); END_PROGRAM`;
    const { runtime, cell } = setup(source);
    const records = JSON.parse(JSON.stringify(runtime.retentiveRecords())) as RetentiveRecord[];
    const record = records[0]!;
    if (record.kind !== "block") throw new Error("Expected retained trigger");
    record.state = { previous: null };
    // Restoring must reset an already used instance to the legacy record's initial M.
    runtime.step();
    runtime.step();
    expect(runtime.restoreRetentive(records)).toEqual([]);
    const normalized = runtime.retentiveRecords()[0]!;
    expect(normalized).toMatchObject({ state: { previous: !input } });
    runtime.warmRestart();
    runtime.step();
    expect(cell("edge")).toMatchObject({ outputs: [{ value: true }] });
    runtime.step();
    expect(cell("edge")).toMatchObject({ outputs: [{ value: false }] });
  },
);

it.each(["R_TRIG", "F_TRIG"])(
  "%s preserves legacy Boolean CLK history when reading retained records",
  (type) => {
    for (const previous of [false, true]) {
      const input = type === "R_TRIG";
      const source = `PROGRAM P VAR RETAIN edge : ${type}; END_VAR
        edge(CLK := ${input}); END_PROGRAM`;
      const { runtime, cell } = setup(source);
      const records = runtime.retentiveRecords();
      const record = records[0]!;
      if (record.kind !== "block") throw new Error("Expected retained trigger");
      record.state = { previous };
      expect(runtime.restoreRetentive(records)).toEqual([]);
      runtime.step();
      expect(cell("edge")).toMatchObject({ outputs: [{ value: previous !== input }] });
      runtime.step();
      expect(cell("edge")).toMatchObject({ outputs: [{ value: false }] });
    }
  },
);

import type { RuntimeToUiMessage, UiToRuntimeMessage } from "@benchtop-plc/core";
import { VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";
import { describe, expect, it } from "vitest";
import { demoProgram } from "./demo.js";
import { createWorkerHost } from "./worker-host.js";

function setup() {
  const clock = new VirtualClock();
  const messages: RuntimeToUiMessage[] = [];
  const host = createWorkerHost(clock, new VirtualTicker(clock), (message) =>
    messages.push(message),
  );
  const snapshot = () => messages.filter((message) => message.type === "snapshot").at(-1)?.snapshot;
  const state = () => messages.filter((message) => message.type === "state").at(-1)?.state;
  host.handle({ type: "load", loadId: 1, ir: demoProgram });
  return { clock, messages, host, snapshot, state };
}

describe("Worker host", () => {
  it("routes force, clear and write messages and publishes their snapshots", () => {
    const { host, clock, snapshot, state, messages } = setup();
    host.handle({ type: "write", variable: 0, value: { dataType: "DINT", value: 10 } });
    expect(snapshot()).toMatchObject({ scanCount: 0, variables: [{ value: 10 }] });
    host.handle({ type: "force", variable: 0, value: { dataType: "DINT", value: 20 } });
    expect(snapshot()?.forced).toEqual([0]);
    host.handle({ type: "step" });
    expect(snapshot()).toMatchObject({ scanCount: 1, variables: [{ value: 20 }] });
    host.handle({ type: "run" });
    host.handle({ type: "write", variable: 0, value: { dataType: "DINT", value: 100 } });
    clock.advance(20);
    expect(snapshot()).toMatchObject({ scanCount: 3, variables: [{ value: 20 }], forced: [0] });
    host.handle({ type: "force", variable: 0, value: null });
    clock.advance(10);
    expect(snapshot()).toMatchObject({ scanCount: 4, variables: [{ value: 21 }], forced: [] });
    host.handle({ type: "write", variable: 0, value: { dataType: "DINT", value: 30 } });
    clock.advance(20);
    expect(snapshot()).toMatchObject({ scanCount: 6, variables: [{ value: 32 }] });
    expect(() =>
      host.handle({ type: "write", variable: 1, value: { dataType: "DINT", value: 1 } }),
    ).not.toThrow();
    expect(messages).toContainEqual({
      type: "rejected",
      command: "write",
      diagnostic: { code: "runtime.debug-target", severity: "error", args: {} },
    });
    expect(state()).toBe("RUN");
    host.handle({ type: "coldReset" });
    expect(snapshot()).toMatchObject({ scanCount: 0, variables: [{ value: 0 }], forced: [] });
  });

  it("rejects debug commands without resetting memory, forces, inputs, state or the ticker", () => {
    const { host, clock, snapshot, state, messages } = setup();
    const ir = structuredClone(demoProgram);
    ir.variables.push({
      kind: "scalar",
      name: "input",
      key: "INPUT",
      dataType: "BOOL",
      initialValue: false,
      address: { area: "I", size: "X", byte: 0, bit: 0 },
      span: ir.span,
    });
    host.handle({ type: "load", loadId: 1, ir });
    host.handle({ type: "setInput", address: "%IX0.0", value: { dataType: "BOOL", value: true } });
    host.handle({ type: "force", variable: 0, value: { dataType: "DINT", value: 50 } });
    host.handle({ type: "run" });
    clock.advance(10);
    const before = snapshot();
    const cases: [UiToRuntimeMessage, string][] = [
      [
        { type: "write", variable: 1, value: { dataType: "BOOL", value: false } },
        "runtime.write-input-mapped",
      ],
      [{ type: "force", variable: 999, value: null }, "runtime.debug-target"],
      [
        { type: "force", variable: 0, value: { dataType: "BOOL", value: true } },
        "runtime.debug-type-mismatch",
      ],
      [
        { type: "write", variable: 0, value: { dataType: "DINT", value: NaN } },
        "runtime.debug-value",
      ],
    ];
    for (const [message, code] of cases) {
      const start = messages.length;
      expect(() => host.handle(message)).not.toThrow();
      expect(messages.slice(start)).toMatchObject([
        { type: "rejected", command: message.type, diagnostic: { code } },
        { type: "state", state: "RUN" },
        { type: "snapshot", snapshot: before },
      ]);
      expect(snapshot()).toEqual(before);
    }
    expect(messages.some((message) => message.type === "fault")).toBe(false);
    clock.advance(10);
    expect(state()).toBe("RUN");
    expect(snapshot()).toMatchObject({
      scanCount: 2,
      variables: [{ value: 50 }, { value: true }],
      forced: [0],
    });
    host.handle({ type: "force", variable: 0, value: null });
    clock.advance(10);
    expect(snapshot()).toMatchObject({ scanCount: 3, variables: [{ value: 51 }, { value: true }] });
  });

  it("executes the IR fixture with injected time and publishes snapshots while running", () => {
    const { host, clock, snapshot, state } = setup();
    expect(state()).toBe("STOP");
    host.handle({ type: "run" });
    expect(state()).toBe("RUN");
    clock.advance(30);
    expect(snapshot()).toMatchObject({ scanCount: 3, variables: [{ value: 3 }] });
    host.handle({ type: "stop" });
    clock.advance(100);
    expect(state()).toBe("STOP");
    expect(snapshot()?.scanCount).toBe(3);
  });

  it("changes the interval without resetting memory, adding duplicate ticks or restarting STOP", () => {
    const { host, clock, messages, snapshot, state } = setup();
    host.handle({ type: "setCycle", ms: 20 });
    clock.advance(100);
    expect(snapshot()?.scanCount).toBe(0);
    host.handle({ type: "run" });
    clock.advance(20);
    host.handle({ type: "setCycle", ms: 50 });
    clock.advance(49);
    expect(snapshot()?.scanCount).toBe(1);
    clock.advance(1);
    expect(snapshot()).toMatchObject({ scanCount: 2, variables: [{ value: 2 }] });
    expect(state()).toBe("RUN");
    expect(() => host.handle({ type: "setCycle", ms: 15 })).not.toThrow();
    expect(messages.filter((message) => message.type === "rejected").at(-1)).toMatchObject({
      command: "setCycle",
      diagnostic: { code: "runtime.unsupported-cycle" },
    });
    host.dispose();
    clock.advance(500);
    expect(snapshot()?.scanCount).toBe(2);
  });

  it("steps only in STOP, resets memory and honors emergency stop", () => {
    const { host, clock, snapshot, state } = setup();
    host.handle({ type: "step" });
    expect(snapshot()).toMatchObject({ scanCount: 1, variables: [{ value: 1 }] });
    expect(state()).toBe("STOP");
    host.handle({ type: "run" });
    host.handle({ type: "step" });
    expect(snapshot()?.scanCount).toBe(1);
    host.handle({ type: "estop", active: true });
    host.handle({ type: "run" });
    host.handle({ type: "step" });
    clock.advance(20);
    expect(snapshot()?.scanCount).toBe(1);
    expect(state()).toBe("ESTOP");
    host.handle({ type: "coldReset" });
    expect(snapshot()).toMatchObject({ scanCount: 0, variables: [{ value: 0 }] });
    expect(state()).toBe("ESTOP");
    host.handle({ type: "estop", active: false });
    expect(state()).toBe("STOP");
  });

  it("publishes latched runtime diagnostics and clears them on reset", () => {
    const { host, messages, state } = setup();
    const faulty = structuredClone(demoProgram);
    const statement = faulty.body[0];
    if (
      statement?.kind !== "assignment" ||
      statement.value.kind !== "binary" ||
      statement.value.right.kind !== "literal"
    )
      throw new Error("Bad fixture");
    statement.value.operator = "/";
    statement.value.right.value = 0;
    host.handle({ type: "load", loadId: 1, ir: faulty });
    host.handle({ type: "step" });
    expect(state()).toBe("FAULT");
    expect(messages.at(-1)).toMatchObject({
      type: "fault",
      diagnostic: { code: "runtime.division-by-zero" },
    });
    host.handle({ type: "run" });
    expect(state()).toBe("FAULT");
    host.handle({ type: "coldReset" });
    expect(state()).toBe("STOP");
    expect(messages.at(-1)?.type).toBe("snapshot");
  });
});

it("publishes panel inputs immediately while STOP or ESTOP prevents scan sampling", () => {
  const { host, snapshot, state } = setup();
  for (const emergency of [false, true]) {
    host.handle({ type: "estop", active: emergency });
    host.handle({ type: "setInput", address: "%IX0.0", value: { dataType: "BOOL", value: true } });
    expect(snapshot()?.inputs[0]).toBe(1);
    expect(snapshot()?.scanCount).toBe(0);
    expect(state()).toBe(emergency ? "ESTOP" : "STOP");
    host.handle({ type: "setInput", address: "%IX0.0", value: { dataType: "BOOL", value: false } });
    expect(snapshot()?.inputs[0]).toBe(0);
  }
});

it("uses a configured interval and reports setCycle rejection without stopping execution", async () => {
  const { compileProject } = await import("@benchtop-plc/compiler");
  const { host, clock, snapshot, state, messages } = setup();
  const ir = compileProject(
    ["PROGRAM P VAR n : INT; END_VAR n := n + 1; END_PROGRAM"],
    [],
    "CONFIGURATION Plant RESOURCE Station ON Cpu TASK T (INTERVAL := T#30ms, PRIORITY := 1); PROGRAM A WITH T : P; PROGRAM B WITH T : P; END_RESOURCE END_CONFIGURATION",
  ).ir!;
  host.handle({ type: "load", loadId: 1, ir });
  host.handle({ type: "run" });
  clock.advance(29);
  expect(snapshot()?.scanCount).toBe(0);
  host.handle({ type: "setCycle", ms: 10 });
  expect(messages).toContainEqual({
    type: "rejected",
    command: "setCycle",
    diagnostic: { code: "runtime.configured-cycle", severity: "error", args: {} },
  });
  expect(state()).toBe("RUN");
  clock.advance(1);
  expect(snapshot()?.variables).toEqual([
    { kind: "scalar", dataType: "INT", value: 1 },
    { kind: "scalar", dataType: "INT", value: 1 },
  ]);
  clock.advance(29);
  expect(snapshot()?.scanCount).toBe(1);
  clock.advance(1);
  expect(snapshot()?.scanCount).toBe(2);
});

it("forwards per-task telemetry in declaration order on every Worker snapshot", async () => {
  const { compileProject } = await import("@benchtop-plc/compiler");
  const { host, clock, snapshot } = setup();
  const ir = compileProject(
    ["PROGRAM P END_PROGRAM"],
    [],
    `CONFIGURATION Plant RESOURCE Station ON Cpu
TASK Fast (INTERVAL := T#10ms, PRIORITY := 0); TASK Slow (INTERVAL := T#30ms, PRIORITY := 1);
PROGRAM A WITH Fast : P; PROGRAM B WITH Slow : P; END_RESOURCE END_CONFIGURATION`,
  ).ir!;
  host.handle({ type: "load", loadId: 1, ir });
  expect(snapshot()?.tasks.map((task) => task.runCount)).toEqual([0, 0]);
  host.handle({ type: "run" });
  clock.advance(90);
  expect(snapshot()?.tasks).toEqual([
    { name: "Fast", runCount: 9, lastExecutionTimeMs: 0, maxExecutionTimeMs: 0, overruns: 0 },
    { name: "Slow", runCount: 3, lastExecutionTimeMs: 0, maxExecutionTimeMs: 0, overruns: 0 },
  ]);
  expect(snapshot()?.scanCount).toBe(9);
});

it("stores typed input values at any input address without decoding invalid real bits", () => {
  const clock = new VirtualClock();
  const messages: RuntimeToUiMessage[] = [];
  const host = createWorkerHost(clock, new VirtualTicker(clock), (m) => messages.push(m));
  host.handle({ type: "setInput", address: "%IW31", value: { dataType: "INT", value: -5 } });
  host.handle({ type: "setInput", address: "%IX63.0", value: { dataType: "BOOL", value: false } });
  host.handle({
    type: "setInput",
    address: "%ID0",
    value: { dataType: "DWORD", value: 0x7fc00000 },
  });
  const last = messages.at(-1)!;
  expect(last.type).toBe("snapshot");
  if (last.type !== "snapshot") throw new Error("Expected snapshot");
  expect(last.snapshot.inputs).toHaveLength(64);
  expect(last.snapshot.inputs.slice(62)).toEqual([251, 254]);
  expect(last.snapshot.inputs.slice(0, 4)).toEqual([0, 0, 192, 127]);
  for (const address of ["%MW0", "%QX0.0", "%IW32", "%I*"])
    expect(() =>
      host.handle({ type: "setInput", address, value: { dataType: "INT", value: 1 } }),
    ).not.toThrow();
  expect(messages.filter((message) => message.type === "rejected")).toHaveLength(4);
  expect(() =>
    host.handle({ type: "setInput", address: "%IW0", value: { dataType: "INT", value: 99999 } }),
  ).not.toThrow();
  expect(messages.filter((message) => message.type === "rejected").at(-1)).toMatchObject({
    command: "setInput",
    diagnostic: { code: "runtime.input-value" },
  });
});

it("publishes complete retained sets at most once a second while running and immediately after commands", () => {
  const { host, clock, messages } = setup();
  const ir = structuredClone(demoProgram);
  ir.variables[0]!.retain = true;
  host.handle({ type: "load", loadId: 1, ir });
  const retained = () => messages.filter((m) => m.type === "retentive");
  expect(retained().at(-1)).toMatchObject({ records: [{ kind: "leaf", value: { value: 0 } }] });
  host.handle({ type: "run" });
  const before = retained().length;
  clock.advance(990);
  expect(retained()).toHaveLength(before);
  clock.advance(10);
  expect(retained()).toHaveLength(before + 1);
  expect(retained().at(-1)).toMatchObject({ records: [{ value: { value: 100 } }] });
  clock.advance(990);
  expect(retained()).toHaveLength(before + 1);
  host.handle({ type: "stop" });
  expect(retained().at(-1)).toMatchObject({ records: [{ value: { value: 199 } }] });
  host.handle({ type: "warmRestart" });
  expect(retained().at(-1)).toMatchObject({ records: [{ value: { value: 199 } }] });
  host.handle({ type: "coldReset" });
  expect(retained().at(-1)).toMatchObject({ records: [{ value: { value: 0 } }] });
});

it("restores retained values during load and reports mismatched paths in STOP", () => {
  const { host, messages, snapshot, state } = setup();
  const ir = structuredClone(demoProgram);
  ir.variables[0]!.retain = true;
  host.handle({ type: "load", loadId: 1, ir });
  const records = messages.filter((m) => m.type === "retentive").at(-1)!.records;
  if (records[0]?.kind !== "leaf") throw new Error("Expected leaf");
  records[0].value = { dataType: "DINT", value: 42 };
  host.handle({
    type: "load",
    loadId: 1,
    ir,
    retentive: [...records, { ...records[0], path: "removed" }],
  });
  expect(state()).toBe("STOP");
  expect(snapshot()?.variables[0]).toMatchObject({ value: 42 });
  expect(messages).toContainEqual({ type: "retentiveRestored", skipped: ["removed"] });
});

it("does not replace saved retained data with an empty set before a program loads", () => {
  const clock = new VirtualClock();
  const messages: RuntimeToUiMessage[] = [];
  const host = createWorkerHost(clock, new VirtualTicker(clock), (message) =>
    messages.push(message),
  );
  host.handle({ type: "setCycle", ms: 50 });
  host.handle({ type: "warmRestart" });
  host.handle({ type: "stop" });
  expect(messages.filter((message) => message.type === "retentive")).toEqual([]);
  host.handle({ type: "load", loadId: 1, ir: demoProgram });
  expect(messages.filter((message) => message.type === "retentive")).toEqual([
    { type: "retentive", records: [] },
  ]);
});

it("publishes final retained values immediately when a scheduled scan faults", () => {
  const clock = new VirtualClock();
  const messages: RuntimeToUiMessage[] = [];
  const host = createWorkerHost(clock, new VirtualTicker(clock), (message) =>
    messages.push(message),
  );
  const ir = structuredClone(demoProgram);
  ir.variables[0]!.retain = true;
  const assignment = ir.body[0]!;
  if (assignment.kind !== "assignment") throw new Error("Expected demo assignment");
  ir.body.push({
    kind: "assignment",
    span: ir.span,
    target: assignment.target,
    value: {
      kind: "binary",
      operator: "/",
      dataType: "DINT",
      span: ir.span,
      left: { kind: "literal", dataType: "DINT", value: 10, span: ir.span },
      right: { kind: "literal", dataType: "DINT", value: 0, span: ir.span },
    },
  });
  host.handle({ type: "load", loadId: 1, ir });
  host.handle({ type: "run" });
  clock.advance(10);
  expect(messages.filter((m) => m.type === "retentive").at(-1)).toMatchObject({
    records: [{ value: { value: 1 } }],
  });
  expect(messages.filter((m) => m.type === "state").at(-1)).toMatchObject({ state: "FAULT" });
});

it("routes body watches and publishes the selected PROGRAM's next single scan", async () => {
  const { compileProject } = await import("@benchtop-plc/compiler");
  const ir = compileProject(
    ["PROGRAM Main VAR n: INT; END_VAR n := n + 1; END_PROGRAM"],
    [],
    "CONFIGURATION C RESOURCE R ON Cpu TASK T(INTERVAL := T#10ms, PRIORITY := 0); PROGRAM A WITH T: Main; PROGRAM B WITH T: Main; END_RESOURCE END_CONFIGURATION",
  ).ir!;
  const { host, snapshot } = setup();
  host.handle({ type: "load", loadId: 1, ir });
  host.handle({ type: "watchBodies", bodies: [{ pou: "Main", instance: "B" }] });
  expect(snapshot()?.annotations).toEqual([]);
  host.handle({ type: "step" });
  expect(snapshot()?.annotations).toMatchObject([{ pou: "Main", instance: "B", scanCount: 1 }]);
  host.handle({ type: "watchBodies", bodies: [] });
  host.handle({ type: "step" });
  expect(snapshot()?.annotations).toEqual([]);
});

it("publishes a halt with a snapshot, rejects controls non-fatally and stores no retentive values during the halt", () => {
  const { host, clock, messages, snapshot, state } = setup();
  const line = demoProgram.body[0]!.span.line;
  host.handle({ type: "setBreakpoints", breakpoints: [{ pou: demoProgram.name, line }] });
  host.handle({ type: "run" });
  clock.advance(10);
  expect(state()).toBe("HALT");
  expect(messages.at(-1)).toMatchObject({
    type: "halted",
    operatingState: "RUN",
    frames: [{ kind: "PROGRAM", span: { line } }],
  });
  expect(messages.at(-2)?.type).toBe("snapshot");
  messages.length = 0;
  clock.advance(5000);
  for (const message of [{ type: "run" }, { type: "step" }, { type: "setCycle", ms: 20 }] as const)
    host.handle(message);
  expect(
    messages
      .filter((message) => message.type === "rejected")
      .map((message) => message.diagnostic.code),
  ).toEqual(["runtime.halted", "runtime.halted", "runtime.halted"]);
  expect(messages.some((message) => message.type === "retentive")).toBe(false);
  expect(snapshot()?.scanCount).toBe(0);
  host.handle({ type: "setBreakpoints", breakpoints: [] });
  host.handle({ type: "continue" });
  expect(state()).toBe("RUN");
  expect(snapshot()?.scanCount).toBe(1);
  host.handle({ type: "continue" });
  expect(messages).toContainEqual({
    type: "rejected",
    command: "continue",
    diagnostic: { code: "runtime.not-halted", severity: "error", args: {} },
  });
  host.dispose();
});

it("echoes a load identity only on its initial snapshot, never on other command replies", () => {
  const { host, messages, clock } = setup();
  host.handle({ type: "load", loadId: 42, ir: demoProgram });
  expect(messages.at(-1)).toMatchObject({
    type: "snapshot",
    loadId: 42,
    snapshot: { scanCount: 0 },
  });
  expect(messages.filter((message) => "loadId" in message && message.loadId === 42)).toHaveLength(
    1,
  );
  messages.length = 0;
  host.handle({ type: "watchBodies", bodies: [] });
  host.handle({ type: "setBreakpoints", breakpoints: [] });
  host.handle({ type: "watch", variables: [] });
  expect(messages.filter((message) => message.type === "snapshot")).toHaveLength(3);
  expect(messages.every((message) => !("loadId" in message))).toBe(true);
  host.handle({ type: "run" });
  clock.advance(10);
  expect(messages.every((message) => !("loadId" in message))).toBe(true);
});

it("completes a failed load with its identity and accepts the next load and run", () => {
  const { host, messages, clock, snapshot, state } = setup();
  const invalid = structuredClone(demoProgram);
  const variable = invalid.variables[0]!;
  if (variable.kind !== "scalar") throw new Error("Expected a scalar fixture");
  variable.initialValue = "invalid integer";
  messages.length = 0;
  expect(() => host.handle({ type: "load", loadId: 2, ir: invalid })).not.toThrow();
  expect(messages).toEqual([
    { type: "state", state: "FAULT" },
    {
      type: "fault",
      loadId: 2,
      diagnostic: { code: "runtime.internal-error", severity: "error", args: {} },
    },
  ]);
  // RUN is queued immediately after load by the store, before its failure is known.
  host.handle({ type: "watchBodies", bodies: [] });
  host.handle({ type: "setBreakpoints", breakpoints: [] });
  host.handle({ type: "run" });
  host.handle({ type: "step" });
  clock.advance(20);
  expect(state()).toBe("FAULT");
  expect(snapshot()?.scanCount).toBe(0);
  expect(messages.filter((message) => "loadId" in message && message.loadId === 2)).toHaveLength(1);
  host.handle({ type: "load", loadId: 3, ir: demoProgram });
  expect(messages.at(-1)).toMatchObject({
    type: "snapshot",
    loadId: 3,
    snapshot: { scanCount: 0 },
  });
  host.handle({ type: "run" });
  clock.advance(10);
  expect(state()).toBe("RUN");
  expect(snapshot()).toMatchObject({ scanCount: 1, variables: [{ value: 1 }] });
  host.dispose();
});

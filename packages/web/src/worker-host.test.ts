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
  host.handle({ type: "load", ir: demoProgram });
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
      address: { area: "I", byte: 0, bit: 0 },
      span: ir.span,
    });
    host.handle({ type: "load", ir });
    host.handle({ type: "setInput", bit: 0, value: true });
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
    const { host, clock, snapshot, state } = setup();
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
    expect(() => host.handle({ type: "setCycle", ms: 15 })).toThrow("cycle");
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
    host.handle({ type: "load", ir: faulty });
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
    host.handle({ type: "setInput", bit: 0, value: true });
    expect(snapshot()?.inputs[0]).toBe(true);
    expect(snapshot()?.scanCount).toBe(0);
    expect(state()).toBe(emergency ? "ESTOP" : "STOP");
    host.handle({ type: "setInput", bit: 0, value: false });
    expect(snapshot()?.inputs[0]).toBe(false);
  }
});

import type { RuntimeToUiMessage } from "@benchtop-plc/core";
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

import type { RuntimeToUiMessage, UiToRuntimeMessage } from "@benchtop-plc/core";
import { VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";
import { expect, it } from "vitest";
import { demoProgram } from "./demo.js";
import { createWorkerHost } from "./worker-host.js";

const diagnostic = { code: "runtime.internal-error", severity: "error", args: {} } as const;

function setup() {
  const clock = new VirtualClock();
  const messages: RuntimeToUiMessage[] = [];
  let failClock = false;
  let failPost = false;
  const host = createWorkerHost(
    {
      now() {
        if (failClock) {
          failClock = false;
          throw new Error("Injected clock error");
        }
        return clock.now();
      },
    },
    new VirtualTicker(clock),
    (message) => {
      if (failPost) {
        failPost = false;
        throw new Error("Injected publishing error");
      }
      messages.push(message);
    },
  );
  host.handle({ type: "load", loadId: 1, ir: demoProgram });
  const state = () => messages.filter((event) => event.type === "state").at(-1)?.state;
  const snapshot = () => messages.filter((event) => event.type === "snapshot").at(-1)?.snapshot;
  return {
    host,
    clock,
    messages,
    state,
    snapshot,
    failClock: () => {
      failClock = true;
    },
    failPost: () => {
      failPost = true;
    },
  };
}

it.each(["STOP", "RUN", "FAULT", "HALT", "ESTOP"] as const)(
  "recovers a command publishing error in %s and latches a fault without losing the host",
  (initial) => {
    const { host, clock, messages, state, snapshot, failPost } = setup();
    if (initial === "RUN" || initial === "HALT") {
      if (initial === "HALT")
        host.handle({
          type: "setBreakpoints",
          breakpoints: [{ pou: demoProgram.name, line: demoProgram.body[0]!.span.line }],
        });
      host.handle({ type: "run" });
      clock.advance(10);
    } else if (initial === "ESTOP") host.handle({ type: "estop", active: true });
    else if (initial === "FAULT") {
      failPost();
      host.handle({ type: "watch", variables: [] });
    }
    expect(state()).toBe(initial);
    failPost();
    expect(() => host.handle({ type: "watch", variables: [] })).not.toThrow();
    expect(state()).toBe(initial === "ESTOP" ? "ESTOP" : "FAULT");
    expect(messages.at(-1)).toEqual({ type: "fault", diagnostic });
    expect(snapshot()?.outputs.every((byte) => byte === 0)).toBe(true);
    const count = snapshot()!.scanCount;
    for (const command of [{ type: "run" }, { type: "step" }, { type: "stop" }] as const)
      host.handle(command);
    clock.advance(100);
    expect(snapshot()?.scanCount).toBe(count);
    if (initial === "ESTOP") host.handle({ type: "estop", active: false });
    expect(state()).toBe("FAULT");
    host.handle({ type: "coldReset" });
    expect(state()).toBe("STOP");
    host.handle({ type: "setBreakpoints", breakpoints: [] });
    host.handle({ type: "run" });
    clock.advance(10);
    expect(state()).toBe("RUN");
    expect(snapshot()?.scanCount).toBe(1);
    host.dispose();
  },
);

it("recovers an unexpected tick error, cancels scanning and permits a warm restart", () => {
  const { host, clock, messages, state, snapshot, failClock } = setup();
  host.handle({ type: "run" });
  clock.advance(10);
  failClock();
  expect(() => clock.advance(10)).not.toThrow();
  expect(state()).toBe("FAULT");
  expect(messages.at(-1)).toEqual({ type: "fault", diagnostic });
  const count = snapshot()!.scanCount;
  clock.advance(100);
  expect(snapshot()?.scanCount).toBe(count);
  host.handle({ type: "warmRestart" });
  expect(state()).toBe("STOP");
  host.handle({ type: "run" });
  clock.advance(10);
  expect(snapshot()?.scanCount).toBe(1);
  host.dispose();
});

it("clears an internal fault by loading a program while preserving an active emergency stop", () => {
  const { host, messages, state, failPost } = setup();
  host.handle({ type: "estop", active: true });
  failPost();
  host.handle({ type: "watch", variables: [] });
  expect(messages.at(-1)).toEqual({ type: "fault", diagnostic });
  messages.length = 0;
  host.handle({ type: "load", loadId: 2, ir: demoProgram });
  expect(state()).toBe("ESTOP");
  expect(messages.some((event) => event.type === "fault")).toBe(false);
  host.handle({ type: "estop", active: false });
  expect(state()).toBe("STOP");
});

it.each([
  { type: "setInput", address: "%MW0", value: { dataType: "INT", value: 1 } },
  { type: "setInput", address: "%IW32", value: { dataType: "INT", value: 1 } },
  { type: "setInput", address: "%IX0.8", value: { dataType: "BOOL", value: true } },
  { type: "setInput", address: "%IW0", value: { dataType: "INT", value: 99999 } },
  { type: "setInput", address: "%IW0", value: { dataType: "BOOL", value: true } },
  { type: "setInput", address: "%ID0", value: { dataType: "REAL", value: Infinity } },
  { type: "setCycle", ms: 0 },
  { type: "setCycle", ms: 11 },
  { type: "setCycle", ms: NaN },
] satisfies UiToRuntimeMessage[])(
  "rejects invalid external command $type without stopping RUN: %j",
  (command) => {
    const { host, clock, messages, state, snapshot } = setup();
    host.handle({ type: "run" });
    messages.length = 0;
    expect(() => host.handle(command)).not.toThrow();
    expect(messages[0]).toMatchObject({ type: "rejected", command: command.type });
    expect(messages.some((event) => event.type === "fault")).toBe(false);
    expect(state()).toBe("RUN");
    expect(snapshot()?.inputs.every((byte) => byte === 0)).toBe(true);
    clock.advance(10);
    expect(snapshot()?.scanCount).toBe(1);
    host.dispose();
  },
);

it("lets an undeliverable fault escape to the Worker's fatal error boundary", () => {
  const clock = new VirtualClock();
  const host = createWorkerHost(clock, new VirtualTicker(clock), () => {
    throw new Error("Broken transport");
  });
  expect(() => host.handle({ type: "load", loadId: 1, ir: demoProgram })).toThrow(
    "Broken transport",
  );
  host.dispose();
});

it("recovers an error in RUN command handling through the injected ticker", () => {
  const clock = new VirtualClock();
  const messages: RuntimeToUiMessage[] = [];
  const ticker = new VirtualTicker(clock);
  let fail = true;
  const host = createWorkerHost(
    clock,
    {
      start(ms, tick) {
        if (fail) {
          fail = false;
          throw new Error("Injected start error");
        }
        return ticker.start(ms, tick);
      },
    },
    (message) => messages.push(message),
  );
  host.handle({ type: "load", loadId: 1, ir: demoProgram });
  expect(() => host.handle({ type: "run" })).not.toThrow();
  expect(messages.at(-1)).toEqual({ type: "fault", diagnostic });
  expect(messages.filter((message) => message.type === "state").at(-1)).toEqual({
    type: "state",
    state: "FAULT",
  });
  host.handle({ type: "coldReset" });
  host.handle({ type: "run" });
  clock.advance(10);
  expect(messages.filter((message) => message.type === "snapshot").at(-1)?.snapshot.scanCount).toBe(
    1,
  );
  host.dispose();
});

it("still posts the fault when snapshots cannot be serialized", () => {
  const clock = new VirtualClock();
  const messages: RuntimeToUiMessage[] = [];
  let rejectSnapshots = false;
  const host = createWorkerHost(clock, new VirtualTicker(clock), (message) => {
    if (rejectSnapshots && message.type === "snapshot")
      throw new DOMException("Invalid snapshot", "DataCloneError");
    messages.push(message);
  });
  host.handle({ type: "load", loadId: 1, ir: demoProgram });
  rejectSnapshots = true;
  expect(() => host.handle({ type: "watch", variables: [] })).not.toThrow();
  expect(messages.at(-1)).toEqual({ type: "fault", diagnostic });
  rejectSnapshots = false;
  host.handle({ type: "coldReset" });
  expect(messages.at(-1)?.type).toBe("snapshot");
  host.dispose();
});

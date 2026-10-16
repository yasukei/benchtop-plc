import type { IoImage, RuntimeToUiMessage, UiToRuntimeMessage } from "@benchtop-plc/core";
import { createRuntime, RuntimeCommandRejected } from "@benchtop-plc/runtime";
import type { Clock, Ticker } from "@benchtop-plc/runtime";
import { cycleOptions, type CycleMs } from "./store.js";

/** Scheduling is injected here as well, so the bridge can be tested without a browser. */
export function createWorkerHost(
  clock: Clock,
  scheduler: Ticker,
  post: (message: RuntimeToUiMessage) => void,
) {
  let cycleMs: CycleMs = 10;
  let activeTick: (() => void) | undefined;
  let cancel: (() => void) | undefined;
  const inputs: IoImage = [false, false, false, false, false, false, false, false];
  const publish = () => {
    post({ type: "state", state: runtime.state });
    post({ type: "snapshot", snapshot: runtime.snapshot() });
    if (runtime.diagnostic) post({ type: "fault", diagnostic: runtime.diagnostic });
  };
  const start = () => {
    cancel = scheduler.start(cycleMs, () => {
      activeTick?.();
      publish();
    });
  };
  const runtime = createRuntime({
    clock,
    ticker: {
      start(_interval, onTick) {
        activeTick = onTick;
        start();
        return () => {
          cancel?.();
          cancel = undefined;
          activeTick = undefined;
        };
      },
    },
    stages: { readInputs: () => inputs },
  });
  return {
    handle(message: UiToRuntimeMessage) {
      switch (message.type) {
        case "load":
          runtime.load(message.ir);
          inputs.fill(false);
          break;
        case "run":
          runtime.run();
          break;
        case "stop":
          runtime.stop();
          break;
        case "step":
          runtime.step();
          break;
        case "coldReset":
          runtime.coldReset();
          inputs.fill(false);
          break;
        case "estop":
          runtime.setEmergencyStop(message.active);
          break;
        case "setInput":
          inputs[message.bit] = message.value;
          break;
        case "setCycle":
          if (!cycleOptions.includes(message.ms as CycleMs))
            throw new RangeError("Unsupported cycle");
          cycleMs = message.ms as CycleMs;
          if (activeTick) {
            cancel?.();
            start();
          }
          break;
        case "force":
        case "write":
          try {
            if (message.type === "force") runtime.force(message.variable, message.value);
            else runtime.write(message.variable, message.value);
          } catch (error) {
            if (!(error instanceof RuntimeCommandRejected)) throw error;
            post({ type: "rejected", command: message.type, diagnostic: error.diagnostic });
          }
          break;
      }
      publish();
    },
    dispose() {
      runtime.stop();
    },
  };
}

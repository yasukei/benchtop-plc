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
  let configured = false;
  const inputs: IoImage = [false, false, false, false, false, false, false, false];
  const publish = () => {
    post({ type: "state", state: runtime.state });
    // The panel input image is live even while STOP prevents scan sampling.
    post({ type: "snapshot", snapshot: { ...runtime.snapshot(), inputs: [...inputs] } });
    if (runtime.diagnostic) post({ type: "fault", diagnostic: runtime.diagnostic });
  };
  const runtime = createRuntime({
    clock,
    ticker: {
      start(interval, onTick) {
        return scheduler.start(interval, () => {
          onTick();
          publish();
        });
      },
    },
    stages: { readInputs: () => inputs },
  });
  return {
    handle(message: UiToRuntimeMessage) {
      switch (message.type) {
        case "load":
          runtime.load(message.ir);
          configured = message.ir.kind === "configuration" && message.ir.explicit;
          inputs.fill(false);
          break;
        case "watch":
          runtime.watch(message.variables);
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
          if (!configured && !cycleOptions.includes(message.ms as CycleMs))
            throw new RangeError("Unsupported cycle");
          try {
            runtime.setCycle(message.ms);
          } catch (error) {
            if (!(error instanceof RuntimeCommandRejected)) throw error;
            post({ type: "rejected", command: "setCycle", diagnostic: error.diagnostic });
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

import {
  parseDirectAddress,
  validDirectAddress,
  writeDirectValue,
  type IoImage,
  type RuntimeToUiMessage,
  type UiToRuntimeMessage,
} from "@benchtop-plc/core";
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
  let lastHalt = "";
  let loaded = false;
  const inputs: IoImage = Array<number>(64).fill(0);
  let lastRetentiveTime = -Infinity;
  let lastRetentiveJson: string | undefined;
  const publish = (immediate = false) => {
    if (
      runtime.state !== "HALT" &&
      loaded &&
      (immediate || clock.now() - lastRetentiveTime >= 1000)
    ) {
      const records = runtime.retentiveRecords();
      const json = JSON.stringify(records);
      if (json !== lastRetentiveJson || immediate) {
        post({ type: "retentive", records });
        lastRetentiveJson = json;
        lastRetentiveTime = clock.now();
      }
    }
    post({ type: "state", state: runtime.state });
    // The panel input image is live even while STOP prevents scan sampling.
    post({ type: "snapshot", snapshot: { ...runtime.snapshot(), inputs: [...inputs] } });
    const halted = runtime.halted;
    const haltKey = JSON.stringify(halted);
    if (halted && haltKey !== lastHalt) post(halted);
    lastHalt = haltKey;
    if (runtime.diagnostic) post({ type: "fault", diagnostic: runtime.diagnostic });
  };
  const runtime = createRuntime({
    clock,
    ticker: {
      start(interval, onTick) {
        return scheduler.start(interval, () => {
          const previousState = runtime.state;
          onTick();
          publish(runtime.state !== previousState);
        });
      },
    },
    stages: { readInputs: () => inputs },
  });
  return {
    handle(message: UiToRuntimeMessage) {
      let immediate = !["watch", "watchBodies", "setBreakpoints", "setInput", "setCycle"].includes(
        message.type,
      );
      try {
        switch (message.type) {
          case "load":
            runtime.load(message.ir);
            loaded = true;
            if (message.retentive !== undefined)
              post({
                type: "retentiveRestored",
                skipped: runtime.restoreRetentive(message.retentive),
              });
            configured = message.ir.kind === "configuration" && message.ir.explicit;
            inputs.fill(0);
            break;
          case "watch":
            runtime.watch(message.variables);
            break;
          case "watchBodies":
            runtime.watchBodies(message.bodies);
            break;
          case "setBreakpoints":
            runtime.setBreakpoints(message.breakpoints);
            break;
          case "debugStep":
            lastHalt = "";
            runtime.debugStep(message.kind);
            break;
          case "continue":
            lastHalt = "";
            runtime.continue();
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
          case "restoreRetentive":
            post({ type: "retentiveRestored", skipped: runtime.restoreRetentive(message.records) });
            inputs.fill(0);
            break;
          case "warmRestart":
            runtime.warmRestart();
            inputs.fill(0);
            break;
          case "coldReset":
            runtime.coldReset();
            inputs.fill(0);
            break;
          case "estop":
            runtime.setEmergencyStop(message.active);
            break;
          case "setInput": {
            const address = parseDirectAddress(message.address);
            if (!address || address.area !== "I" || !validDirectAddress(address))
              throw new RangeError("Invalid input address");
            writeDirectValue(inputs, address, message.value);
            break;
          }
          case "setCycle":
            if (
              runtime.state !== "HALT" &&
              !configured &&
              !cycleOptions.includes(message.ms as CycleMs)
            )
              throw new RangeError("Unsupported cycle");
            runtime.setCycle(message.ms);
            break;
          case "force":
            runtime.force(message.variable, message.value);
            break;
          case "write":
            runtime.write(message.variable, message.value);
            break;
        }
      } catch (error) {
        if (!(error instanceof RuntimeCommandRejected)) throw error;
        if (
          message.type !== "run" &&
          message.type !== "step" &&
          message.type !== "continue" &&
          message.type !== "debugStep" &&
          message.type !== "setCycle" &&
          message.type !== "force" &&
          message.type !== "write"
        )
          throw error;
        immediate = false;
        post({ type: "rejected", command: message.type, diagnostic: error.diagnostic });
      }
      publish(immediate);
    },
    dispose() {
      runtime.stop();
    },
  };
}

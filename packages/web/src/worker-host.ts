import {
  addressBinds,
  parseDirectAddress,
  validateValue,
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
  report: (error: unknown) => void = () => {},
) {
  let configured = false;
  let lastHalt = "";
  let loaded = false;
  const inputs: IoImage = Array<number>(64).fill(0);
  let lastRetentiveTime = -Infinity;
  let lastRetentiveJson: string | undefined;
  const publish = (immediate = false, loadId?: number) => {
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
    // Compute publication data before acknowledging a successful load.
    const state = runtime.state;
    const halted = runtime.halted;
    const haltKey = JSON.stringify(halted);
    const diagnostic = runtime.diagnostic;
    // The panel input image is live even while STOP prevents scan sampling.
    const snapshot = {
      type: "snapshot" as const,
      snapshot: { ...runtime.snapshot(), inputs: [...inputs] },
      ...(loadId === undefined ? {} : { loadId }),
    };
    post({ type: "state", state });
    if (loadId === undefined) post(snapshot);
    if (halted && haltKey !== lastHalt) post(halted);
    lastHalt = haltKey;
    if (diagnostic) post({ type: "fault", diagnostic });
    // The load completion must be last: no subsequent error can complete it twice.
    if (loadId !== undefined) post(snapshot);
  };
  const runtime = createRuntime({
    clock,
    ticker: {
      start(interval, onTick) {
        return scheduler.start(interval, () => {
          try {
            const previousState = runtime.state;
            onTick();
            publish(runtime.state !== previousState);
          } catch (error) {
            recover(error);
          }
        });
      },
    },
    stages: { readInputs: () => inputs },
  });
  // Recovery deliberately avoids retention/debugger publishing, which may be the defect.
  // If stopping execution or posting the fault fails, let the Worker error remain fatal.
  const reportError = (error: unknown) => {
    try {
      report(error);
    } catch {
      // Developer reporting must not prevent stopping execution or fault delivery.
    }
  };
  const recover = (error: unknown, loadId?: number) => {
    reportError(error);
    runtime.fail();
    lastHalt = "";
    if (loadId !== undefined) loaded = false;
    post({ type: "state", state: runtime.state });
    if (loadId === undefined) {
      try {
        post({ type: "snapshot", snapshot: { ...runtime.snapshot(), inputs: [...inputs] } });
      } catch (snapshotError) {
        reportError(snapshotError);
        // A broken or unserializable snapshot must not prevent fault delivery.
      }
    }
    post({
      type: "fault",
      diagnostic: { code: "runtime.internal-error", severity: "error", args: {} },
      ...(loadId === undefined ? {} : { loadId }),
    });
  };
  return {
    handle(message: UiToRuntimeMessage) {
      const immediate = ![
        "watch",
        "watchBodies",
        "setBreakpoints",
        "setInput",
        "setCycle",
      ].includes(message.type);
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
            if (loaded) runtime.run();
            break;
          case "stop":
            runtime.stop();
            break;
          case "step":
            if (loaded) runtime.step();
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
              throw new RuntimeCommandRejected({
                code: "runtime.input-address",
                severity: "error",
                args: {},
              });
            if (!addressBinds(address, message.value.dataType))
              throw new RuntimeCommandRejected({
                code: "runtime.input-value",
                severity: "error",
                args: {},
              });
            try {
              validateValue(message.value.dataType, message.value.value);
            } catch (error) {
              if (!(error instanceof RangeError)) throw error;
              throw new RuntimeCommandRejected({
                code: "runtime.input-value",
                severity: "error",
                args: {},
              });
            }
            writeDirectValue(inputs, address, message.value);
            break;
          }
          case "setCycle":
            if (
              runtime.state !== "HALT" &&
              !configured &&
              !cycleOptions.includes(message.ms as CycleMs)
            )
              throw new RuntimeCommandRejected({
                code: "runtime.unsupported-cycle",
                severity: "error",
                args: {},
              });
            runtime.setCycle(message.ms);
            break;
          case "force":
            runtime.force(message.variable, message.value);
            break;
          case "write":
            runtime.write(message.variable, message.value);
            break;
        }
        publish(immediate, message.type === "load" ? message.loadId : undefined);
      } catch (error) {
        if (!(error instanceof RuntimeCommandRejected)) {
          recover(error, message.type === "load" ? message.loadId : undefined);
          return;
        }
        if (
          message.type !== "run" &&
          message.type !== "step" &&
          message.type !== "continue" &&
          message.type !== "debugStep" &&
          message.type !== "setCycle" &&
          message.type !== "setInput" &&
          message.type !== "force" &&
          message.type !== "write"
        ) {
          recover(error, message.type === "load" ? message.loadId : undefined);
          return;
        }
        try {
          post({ type: "rejected", command: message.type, diagnostic: error.diagnostic });
          publish(false);
        } catch (publicationError) {
          recover(publicationError);
        }
      }
    },
    dispose() {
      runtime.stop();
    },
  };
}

import type { UiToRuntimeMessage } from "@benchtop-plc/core";
import { createWorkerHost } from "./worker-host.js";

const host = createWorkerHost(
  { now: () => performance.now() },
  {
    start(ms, onTick) {
      const id = setInterval(onTick, ms);
      return () => clearInterval(id);
    },
  },
  (message) => postMessage(message),
);

addEventListener("message", (event: MessageEvent<UiToRuntimeMessage>) => host.handle(event.data));

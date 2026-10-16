import type { RuntimeToUiMessage, UiToRuntimeMessage } from "@benchtop-plc/core";
import type { RuntimeWorker } from "./runtime-client.js";

export class FakeWorker extends EventTarget implements RuntimeWorker {
  readonly sent: UiToRuntimeMessage[] = [];
  terminated = false;
  postMessage(message: UiToRuntimeMessage): void {
    this.sent.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  receive(message: RuntimeToUiMessage): void {
    this.dispatchEvent(new MessageEvent("message", { data: message }));
  }
}

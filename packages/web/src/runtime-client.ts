import type { RuntimeToUiMessage, UiToRuntimeMessage } from "@benchtop-plc/core";

/** The small Worker surface used by the client, also implemented by test doubles. */
export interface RuntimeWorker {
  postMessage(message: UiToRuntimeMessage): void;
  addEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
  removeEventListener(type: "message" | "error" | "messageerror", listener: EventListener): void;
  terminate(): void;
}

export type ClientEvent = RuntimeToUiMessage | { type: "connectionError" } | { type: "closed" };

export class RuntimeClient {
  private readonly listeners = new Set<(event: ClientEvent) => void>();
  private closed = false;
  private readonly onMessage: EventListener = (event) => {
    this.emit((event as MessageEvent<RuntimeToUiMessage>).data);
  };
  private readonly onError: EventListener = () => {
    this.shutdown();
    this.emit({ type: "connectionError" });
  };

  constructor(private readonly worker: RuntimeWorker) {
    worker.addEventListener("message", this.onMessage);
    worker.addEventListener("error", this.onError);
    worker.addEventListener("messageerror", this.onError);
  }

  subscribe(listener: (event: ClientEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  send(message: UiToRuntimeMessage): void {
    if (this.closed) throw new Error("Runtime client is closed");
    try {
      this.worker.postMessage(message);
    } catch {
      this.onError(new Event("error"));
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.shutdown();
    this.emit({ type: "closed" });
    this.listeners.clear();
  }

  private emit(event: ClientEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private shutdown(): void {
    this.closed = true;
    this.worker.removeEventListener("message", this.onMessage);
    this.worker.removeEventListener("error", this.onError);
    this.worker.removeEventListener("messageerror", this.onError);
    this.worker.terminate();
  }
}

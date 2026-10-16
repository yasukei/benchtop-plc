import { describe, expect, it, vi } from "vitest";
import { demoProgram } from "./demo.js";
import { FakeWorker } from "./fake-worker.test-support.js";
import { RuntimeClient } from "./runtime-client.js";

describe("RuntimeClient", () => {
  it("forwards command rejections without terminating the Worker or blocking later commands", () => {
    const worker = new FakeWorker();
    const client = new RuntimeClient(worker);
    const listener = vi.fn();
    client.subscribe(listener);
    const rejection = {
      type: "rejected",
      command: "write",
      diagnostic: {
        code: "runtime.write-input-mapped",
        severity: "error",
        args: { name: "input" },
      },
    } as const;
    worker.receive(rejection);
    expect(listener).toHaveBeenCalledExactlyOnceWith(rejection);
    expect(worker.terminated).toBe(false);
    client.send({ type: "run" });
    expect(worker.sent).toEqual([{ type: "run" }]);
  });

  it("forwards protocol commands and Worker messages and supports unsubscribe", () => {
    const worker = new FakeWorker();
    const client = new RuntimeClient(worker);
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    client.send({ type: "load", ir: demoProgram });
    client.send({ type: "run" });
    expect(worker.sent).toEqual([{ type: "load", ir: demoProgram }, { type: "run" }]);
    worker.receive({ type: "state", state: "RUN" });
    expect(listener).toHaveBeenCalledWith({ type: "state", state: "RUN" });
    unsubscribe();
    worker.receive({ type: "state", state: "STOP" });
    expect(listener).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("terminates and removes Worker listeners on disposal", () => {
    const worker = new FakeWorker();
    const client = new RuntimeClient(worker);
    const listener = vi.fn();
    client.subscribe(listener);
    client.dispose();
    client.dispose();
    worker.receive({ type: "state", state: "RUN" });
    worker.dispatchEvent(new Event("error"));
    expect(listener.mock.calls).toEqual([[{ type: "closed" }]]);
    expect(worker.terminated).toBe(true);
    expect(() => client.send({ type: "run" })).toThrow("closed");
  });

  it.each(["error", "messageerror"])("reports %s and closes the failed Worker", (type) => {
    const worker = new FakeWorker();
    const client = new RuntimeClient(worker);
    const listener = vi.fn();
    client.subscribe(listener);
    worker.dispatchEvent(new Event(type));
    worker.dispatchEvent(new Event(type));
    expect(listener.mock.calls).toEqual([[{ type: "connectionError" }]]);
    expect(worker.terminated).toBe(true);
    expect(() => client.send({ type: "run" })).toThrow("closed");
  });

  it("reports synchronous postMessage failure", () => {
    const worker = new FakeWorker();
    vi.spyOn(worker, "postMessage").mockImplementation(() => {
      throw new Error("Clone failed");
    });
    const client = new RuntimeClient(worker);
    const listener = vi.fn();
    client.subscribe(listener);
    client.send({ type: "load", ir: demoProgram });
    expect(listener).toHaveBeenCalledWith({ type: "connectionError" });
    expect(worker.terminated).toBe(true);
  });
});

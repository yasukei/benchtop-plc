import { expect, it } from "vitest";
import { TaskScheduler } from "./task-scheduler.js";

it("excludes only skipped cyclic activations inside halts, retaining real overruns between them", () => {
  const scheduler = new TaskScheduler([{ name: "Fast", intervalMs: 10, priority: 1 }]);
  scheduler.resume(0);
  expect(scheduler.ready(10, false, () => false)).toEqual([0]);
  scheduler.excludeHalt(12, 32); // Deadlines 20, 30.
  scheduler.excludeHalt(42, 62); // Deadlines 50, 60; 40 is an actual overrun.
  scheduler.finish(0, 10, 65, false, 40);
  expect(scheduler.snapshot()).toEqual([
    { name: "Fast", runCount: 1, lastExecutionTimeMs: 15, maxExecutionTimeMs: 15, overruns: 1 },
  ]);
  expect(scheduler.ready(69, false, () => false)).toEqual([]);
  expect(scheduler.ready(70, false, () => false)).toEqual([0]);
  scheduler.finish(0, 70, 80, false);
  expect(scheduler.snapshot()[0]).toMatchObject({
    runCount: 2,
    lastExecutionTimeMs: 10,
    maxExecutionTimeMs: 15,
    overruns: 2,
  });
});

it("retains one activation for other overdue tasks and excludes a halt's start but not its end from overruns", () => {
  const scheduler = new TaskScheduler([{ name: "Slow", intervalMs: 100, priority: 1 }]);
  scheduler.resume(0);
  scheduler.excludeHalt(100, 500);
  expect(scheduler.ready(501, false, () => false)).toEqual([0]);
  scheduler.finish(0, 501, 502, false);
  expect(scheduler.snapshot()[0]).toMatchObject({ runCount: 1, overruns: 1 });
  expect(scheduler.ready(599, false, () => false)).toEqual([]);
  expect(scheduler.ready(600, false, () => false)).toEqual([0]);
});

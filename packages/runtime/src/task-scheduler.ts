import type { EventInputIR, TaskIR, TaskTelemetry } from "@benchtop-plc/core";

const gcd = (a: number, b: number): number => {
  while (b) [a, b] = [b, a % b];
  return a;
};

/** Readiness is frozen at pass start; execution never adds tasks to the current pass. */
export class TaskScheduler {
  private due: number[];
  private sampled: boolean[];
  private telemetry: TaskTelemetry[];
  readonly intervalMs: number;

  constructor(readonly tasks: readonly TaskIR[]) {
    this.intervalMs =
      tasks.reduce(
        (interval, task) => ("intervalMs" in task ? gcd(interval, task.intervalMs) : interval),
        0,
      ) || 10;
    this.due = tasks.map(() => 0);
    this.sampled = tasks.map(() => false);
    this.telemetry = tasks.map(({ name }) => ({
      name,
      runCount: 0,
      lastExecutionTimeMs: 0,
      maxExecutionTimeMs: 0,
      overruns: 0,
    }));
  }

  /** Resuming restarts cyclic deadlines, while preserving event samples and statistics. */
  resume(now: number): void {
    this.tasks.forEach((task, index) => {
      if ("intervalMs" in task) this.due[index] = now + task.intervalMs;
    });
  }

  ready(now: number, singleScan: boolean, read: (input: EventInputIR) => boolean): number[] {
    const ready: { index: number; since: number; priority: number }[] = [];
    this.tasks.forEach((task, index) => {
      if ("intervalMs" in task) {
        if (singleScan || this.due[index]! <= now)
          ready.push({
            index,
            since: singleScan ? now : this.due[index]!,
            priority: task.priority,
          });
      } else {
        const value = read(task.single);
        if (value && !this.sampled[index])
          ready.push({ index, since: now, priority: task.priority });
        this.sampled[index] = value;
      }
    });
    return ready
      .sort((a, b) => a.priority - b.priority || a.since - b.since || a.index - b.index)
      .map(({ index }) => index);
  }

  finish(index: number, start: number, end: number, singleScan: boolean): void {
    const telemetry = this.telemetry[index]!;
    telemetry.runCount++;
    telemetry.lastExecutionTimeMs = end - start;
    telemetry.maxExecutionTimeMs = Math.max(telemetry.maxExecutionTimeMs, end - start);
    const task = this.tasks[index]!;
    if (!singleScan && "intervalMs" in task) {
      let due = this.due[index]! + task.intervalMs;
      if (due <= end) {
        const missed = Math.floor((end - due) / task.intervalMs) + 1;
        telemetry.overruns += missed;
        due += missed * task.intervalMs;
      }
      this.due[index] = due;
    }
  }

  snapshot(): TaskTelemetry[] {
    return this.telemetry.map((task) => ({ ...task }));
  }
}

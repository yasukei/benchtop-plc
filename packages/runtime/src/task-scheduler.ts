import type { EventInputIR, TaskIR, TaskTelemetry } from "@benchtop-plc/core";

const gcd = (a: number, b: number): number => {
  while (b) [a, b] = [b, a % b];
  return a;
};

/** Readiness is frozen at pass start; execution never adds tasks to the current pass. */
export class TaskScheduler {
  private due: number[];
  private excludedActivations: number[];
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
    this.excludedActivations = tasks.map(() => 0);
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
    this.excludedActivations.fill(0);
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

  excludeHalt(start: number, end: number): void {
    this.tasks.forEach((task, index) => {
      if (!("intervalMs" in task)) return;
      const due = this.due[index]!;
      // Keep the oldest overdue activation, excluding only later deadlines.
      const first = Math.max(1, Math.ceil((start - due) / task.intervalMs));
      const last = Math.ceil((end - due) / task.intervalMs) - 1;
      this.excludedActivations[index]! += Math.max(0, last - first + 1);
    });
  }

  finish(index: number, start: number, end: number, singleScan: boolean, pausedMs = 0): void {
    const telemetry = this.telemetry[index]!;
    telemetry.runCount++;
    telemetry.lastExecutionTimeMs = end - start - pausedMs;
    telemetry.maxExecutionTimeMs = Math.max(telemetry.maxExecutionTimeMs, end - start - pausedMs);
    const task = this.tasks[index]!;
    if (!singleScan && "intervalMs" in task) {
      let due = this.due[index]! + task.intervalMs;
      if (due <= end) {
        const missed = Math.floor((end - due) / task.intervalMs) + 1;
        telemetry.overruns += missed - this.excludedActivations[index]!;
        due += missed * task.intervalMs;
      }
      this.due[index] = due;
    }
    this.excludedActivations[index] = 0;
  }

  snapshot(): TaskTelemetry[] {
    return this.telemetry.map((task) => ({ ...task }));
  }
}

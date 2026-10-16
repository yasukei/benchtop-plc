/** Milliseconds from a host-defined monotonic origin. */
export interface Clock {
  now(): number;
}

export interface Ticker {
  start(intervalMs: number, onTick: () => void): () => void;
}

export function checkInterval(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError("Interval must be positive and finite");
}

interface Tick {
  interval: number;
  due: number;
  callback: () => void;
}

/** Pure ECMAScript clock. All matching tickers share its chronological queue. */
export class VirtualClock implements Clock {
  private time = 0;
  private advancing = false;
  private readonly ticks = new Set<Tick>();

  now(): number {
    return this.time;
  }

  schedule(interval: number, callback: () => void): () => void {
    checkInterval(interval);
    const due = this.time + interval;
    if (!Number.isFinite(due) || due <= this.time) throw new RangeError("Tick time cannot advance");
    const tick = { interval, due, callback };
    this.ticks.add(tick);
    return () => {
      this.ticks.delete(tick);
    };
  }

  advance(ms: number): void {
    const end = this.time + ms;
    if (!Number.isFinite(ms) || ms < 0 || !Number.isFinite(end)) {
      throw new RangeError("Advance must be nonnegative and finite");
    }
    if (this.advancing) throw new Error("VirtualClock.advance cannot be nested");
    this.advancing = true;
    try {
      for (;;) {
        let next: Tick | undefined;
        for (const tick of this.ticks) {
          if (tick.due <= end && (!next || tick.due < next.due)) next = tick;
        }
        if (!next) break;
        this.time = next.due;
        const due = next.due + next.interval;
        if (!Number.isFinite(due) || due <= next.due) {
          this.ticks.delete(next);
          throw new RangeError("Tick time cannot advance");
        }
        next.due = due;
        next.callback();
      }
      this.time = end;
    } finally {
      this.advancing = false;
    }
  }
}

export class VirtualTicker implements Ticker {
  constructor(private readonly clock: VirtualClock) {}

  start(intervalMs: number, onTick: () => void): () => void {
    return this.clock.schedule(intervalMs, onTick);
  }
}

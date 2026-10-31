# 0026. Injected ticker contract

- Status: Accepted
- Date: 2026-10-31
- Extends: [0003. Injected clock](0003-injected-clock.md)
- Related: [0016](0016-configurations-tasks-and-global-variables.md)
- Source: [issue #238](https://github.com/yasukei/benchtop-plc/issues/238)

## Context

ADR 0003 defines the injected monotonic `Clock`, but ADR 0016 also relies on an
injected `Ticker` to trigger scheduler passes. The headless runtime, virtual test
ticker and Worker host already implement this separation. Their scheduling and
cancellation rules need a recorded contract so new adapters preserve it.

## Decision

Extend ADR 0003 with the existing `Ticker` dependency:

```ts
interface Ticker {
  start(intervalMs: number, onTick: () => void): () => void;
}
```

- `start` registers a repeating callback with a positive finite interval in
  milliseconds. The first callback is due one interval after registration;
  registration does not invoke it immediately. Each call creates an independent
  registration.
- The returned function cancels that registration. Cancellation is idempotent,
  including when called from its own callback, and prevents subsequent dispatches;
  it does not interrupt a callback already executing.
- `Ticker` schedules work; `Clock.now()` supplies monotonic time. The runtime uses
  the injected clock for task readiness, timer values and execution telemetry.
  Production adapters belong to the Worker host and use host scheduling APIs.
  Host callbacks may arrive late; the ticker does not promise exact wall-clock
  delivery or replace ADR 0016's missed-activation and overrun rules. The runtime
  also guards stale callbacks when stopping or replacing a ticker.

For deterministic tests, `VirtualTicker` registers on its injected `VirtualClock`:

- All tickers sharing a virtual clock share one queue. `advance(ms)` dispatches
  every callback due at or before the target time in chronological order, with
  ties broken by original registration order. Before each callback, `now()` is
  its due time. Repeated deadlines advance from the previous due time by the
  interval; an advance across several deadlines dispatches each one.
- Cancellation and registration inside callbacks take effect immediately. A
  callback can cancel a later callback at the same deadline. A new registration
  is first due one interval after the current virtual time and can run in the
  same `advance` call if its deadline is within the target.
- After a successful advance, `now()` is the target time. Advances must be finite
  and nonnegative; nested advances are programming errors. An interval or deadline
  that cannot advance to a later finite time is rejected. If a callback throws,
  the error propagates and the clock stays at that callback's due time; its next
  deadline has already been scheduled, and the clock remains usable.

### Verification

[Clock tests](../../packages/runtime/src/clock.test.ts) cover shared chronological
ordering and registration ties, cancellation during callbacks, new registrations,
invalid intervals/advances, nested advances and recovery after callback errors.

## Consequences

- Tests can advance time exactly without depending on host timers, while production
  scheduling remains outside the headless runtime.
- Adapter implementations have explicit first-tick and cancellation rules; virtual
  dispatch order is deterministic even when callbacks change the queue.
- This records existing behavior without changing `Clock`, `Ticker`, or scheduler
  policy, and does not impose virtual catch-up dispatch on host timers.

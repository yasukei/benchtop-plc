# 0003. Injected clock

- Status: Accepted
- Date: 2026-10-16

## Context
Timers (TON, TOF, TP) are the core of PLC programs. Tests that depend on wall-clock time are slow and flaky.

## Decision
Runtime code never reads the wall clock directly. It receives a `Clock` (`now(): number` in milliseconds). Production uses a real clock; tests use a virtual clock that advances explicitly. FB timers use the scan start time.

## Consequences
Timer behaviour is tested exactly and instantly (e.g. Q is FALSE at PT − 1 ms and TRUE at PT). Every new time-dependent feature must take the clock as a dependency.

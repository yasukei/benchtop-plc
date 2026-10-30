# 0020. Recover unexpected Worker errors as internal faults

- Status: Accepted
- Date: 2026-10-31
- Related: [0004](0004-diagnostics-as-codes-with-arguments.md),
  [0009](0009-emergency-stop-overlay.md),
  [0010](0010-operating-states-restarts-and-runtime-errors.md),
  [0018](0018-debugging.md), [#217](https://github.com/yasukei/benchtop-plc/issues/217)

## Context

A defect in command handling, the runtime, the debugger or publication can throw
out of the Worker listener or scheduled tick. The client then terminates the
connection and requires a page reload. The runtime already de-energizes outputs
for unexpected scan errors but does not attach a diagnostic. Failed loads also
need exactly one completion carrying their attempt's `loadId` (#214).

## Decision

The Worker host catches unexpected errors from command handling and tick callbacks,
including their normal publication. It calls the runtime's host-facing `fail()`
method to latch `runtime.internal-error`, cancel ticks, abandon the suspended pass
and debugger halt, and turn outputs OFF. It publishes the resulting state and a
`fault` containing this code with no exception text, stack or source attribution.
This is an application error, not an IEC program error.

| Before the error               | After the error  | What the user sees                                                                                   |
| ------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------- |
| STOP                           | FAULT            | Fault status and localized internal-error diagnostic                                                 |
| RUN                            | FAULT            | Scanning stopped, outputs OFF and the diagnostic                                                     |
| FAULT                          | FAULT            | Internal-error diagnostic replaces the previous fault                                                |
| HALT over RUN or STOP          | FAULT            | Suspended scan abandoned, halt banner cleared, outputs OFF and the diagnostic                        |
| ESTOP over any operating state | ESTOP over FAULT | E-STOP remains active and the internal-error diagnostic is displayed; releasing E-STOP reveals FAULT |

Successful cold reset, warm restart (Acknowledge fault) or load clears the fault
and returns the underlying operating state to STOP. They preserve an active
E-STOP. Stop, run, single scan, E-STOP toggles, watches and input/debug commands do
not clear it or resume scanning. A successful restart or load never starts RUN
implicitly. Commands with expected validation failures still produce `rejected`,
without changing operating state or the latched fault.

A failed load completes with exactly one `fault` carrying its `loadId` and
`runtime.internal-error`, without a load snapshot. This replaces the previous
`runtime.load-failed` response. The store discards the pending load and hides old
monitor values. Queued run/single-scan commands cannot execute the previous
program, even after reset; a successful load must enable execution again.
The user acknowledges or resets the fault and retries the load or opens another
project, using the same connection.

Recovery bypasses retention and debugger publication, since those may have caused
the error. For a non-load command or tick it attempts an ordinary snapshot, but
snapshot construction or serialization failure cannot prevent fault delivery. The state and fault
still reach the UI; later successful snapshots refresh the monitor. Recovery does
not retry the failed command or tick. Load snapshots are published last, so an
error cannot follow a successful load completion within the same publication.

The connection is terminated only if the Worker cannot continue: startup fails,
recovery cannot stop the runtime, posting recovery messages fails, or transport
reports `error`/`messageerror`. Such errors escape to the existing fatal boundary.
The user then sees the connection-error banner and disabled runtime controls and
must reload. A recoverable internal fault leaves the connection active and reset
controls available. No fault-injection command or hook is shipped in the Worker;
tests inject failures through its existing clock, ticker and post dependencies.

Invalid `setInput` addresses produce `runtime.input-address`; incompatible types
or invalid values produce `runtime.input-value`. Validation completes before the
input image changes. An unsupported implicit `setCycle` produces
`runtime.unsupported-cycle`. HALT and explicit-configuration rejection precedence
remain unchanged (`runtime.halted`, `runtime.configured-cycle`). All are nonfatal
`rejected` events identifying the command, rendered in the separate rejection alert.

## Consequences

- Most Worker defects can be cleared without losing the browser session.
- A defect can recur after reset; recovery reports it again rather than hiding it.
- Host failures become visible in STOP and under overlays as well as during RUN.
- Fault recovery preserves inspectable memory where possible, but does not promise
  to repair partially mutated program storage or publish retained data from it.
- The core protocol adds `setInput` to rejection commands and four diagnostic codes;
  the runtime exposes `fail()` for hosts without importing web concerns.

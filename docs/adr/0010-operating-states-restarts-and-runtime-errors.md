# 0010. Operating states, restarts and run-time errors

- Status: Accepted
- Date: 2026-10-17
- Related: [0009](0009-emergency-stop-overlay.md)

## Context

IEC 61131-3 does not define an operating-state machine. It only says that
starting a resource initializes its variables and then enables its tasks, and
that stopping a resource disables its tasks (Ed.3 §4.1). It lists which
conditions are errors (for example division by zero, results outside a type's
range, missed task deadlines) but leaves the reaction to the implementation,
and requires the implementation to document the errors it detects and reports
(§5.1 e). Cold and warm restart are defined by their effect on retentive
variables (§6.5.6, Figure 9): a warm restart keeps `RETAIN` variables, a cold
restart initializes everything.

Vendors fill these gaps differently. CODESYS, TwinCAT and Rockwell have a
distinct fault/exception state; Siemens S7-1500 falls back to STOP and records
the cause in a diagnostic buffer. Vendor command names are not comparable:
TwinCAT "Reset cold" keeps `RETAIN` variables, which is what CODESYS calls
"Reset Warm". IEC 61131-5 borrows the MMS (ISO 9506) program-invocation model,
which distinguishes *stopped* (continue with Resume) from *idle* (start from
initial values) and has a state from which normal Start/Resume cannot leave.

The research behind this decision, with sources and open questions, is in the
maintainer's report on PLC operating states and fault handling (2026-10-17).

## Decision

**States.** The operating state is `STOP`, `RUN` or `FAULT`. The emergency stop
is a separate flag laid over it (ADR 0009). There are no transitional states.

| From  | Event                         | To    | Variables                       |
|-------|-------------------------------|-------|---------------------------------|
| STOP  | run                           | RUN   | kept (resume)                   |
| STOP  | single scan                   | STOP  | kept; one scan executes         |
| RUN   | stop                          | STOP  | kept                            |
| RUN   | run-time error or watchdog    | FAULT | kept for inspection             |
| FAULT | run, single scan              | FAULT | rejected                        |
| any   | cold reset                    | STOP  | all initialized; fault cleared  |
| any   | load program                  | STOP  | all initialized; fault cleared  |

There is no transition from `FAULT` to `RUN`. Outputs are OFF in every state
except `RUN`, and whenever the emergency stop is active.

**STOP → RUN resumes.** Variables keep their values, like MMS Resume and like
CODESYS/TwinCAT Start after Stop. This is an implementation choice: IEC 61131-3
§4.1 describes starting a resource with initialization, which here corresponds
to cold reset (or, later, warm restart) followed by run.

**Restart kinds are defined by their effect on variables**, never by vendor
names:

| Restart       | VAR / NON_RETAIN | RETAIN      | Available             |
|---------------|------------------|-------------|-----------------------|
| Resume        | kept             | kept        | Milestone 1           |
| Warm restart  | initialized      | kept        | when RETAIN is added  |
| Cold restart  | initialized      | initialized | Milestone 1 (cold reset) |

Unqualified variables behave as `NON_RETAIN` on a warm restart (IEC leaves this
to the implementation). `PERSISTENT` is not part of IEC 61131-3; if it is ever
added, it is a documented extension with its own column.

**Fault clearing.** In Milestone 1 a fault is cleared only by cold reset or by
loading a program. Because Milestone 1 has no `RETAIN` variables, this loses
nothing. When `RETAIN` is introduced, add an explicit "acknowledge fault"
command that performs a warm restart and goes to `STOP`; it must never go
directly to `RUN`, and it must not clear the fault history.

**Run-time error reactions** (the documentation required by IEC 61131-3 §5.1 e):

| Condition                                        | Reaction                                       |
|--------------------------------------------------|------------------------------------------------|
| Integer division by zero                         | FAULT `runtime.division-by-zero`               |
| REAL/LREAL division by zero                      | FAULT `runtime.division-by-zero`               |
| `x MOD 0`                                        | Result `0`, no fault (IEC 61131-3 defines it)  |
| REAL/LREAL result non-finite or out of range     | FAULT `runtime.invalid-value`                  |
| Integer result outside the target type           | Wraps to the target type (two's complement)    |
| `FOR ... BY 0`                                   | FAULT `runtime.for-by-zero`                    |
| More than 200,000 loop iterations in one scan    | FAULT `runtime.watchdog`                       |
| TIME outside the representable range             | To be decided in #24                           |

±Inf and NaN never become variable values. IEC 61131-3 treats them as the
result of an error; `IS_VALID` is therefore not needed to guard against them
here. A fault stops the whole program, not a single task.

**The emergency stop is not a safety function.** A browser simulator is outside
the scope of IEC 60204-1 and ISO 13850; ADR 0009 imitates their principles (the
stop persists until reset, and reset only permits a restart) but claims no
conformance. It models stop category 0 only (outputs OFF immediately). Halting
the scan is a simplification: on real machines the emergency stop removes
actuator power while the standard PLC keeps scanning.

## Consequences

- Users can stop, inspect and continue a program without losing state, which
  suits debugging and teaching.
- `x MOD 0 = 0` matches the standard but may surprise users who expect a fault;
  the conformance tests make the behavior explicit.
- Integer wrap-around is silent. A later option may report overflow (as Rockwell
  does with a status flag) without changing this default.
- Adding `RETAIN` later only adds the warm-restart row and the acknowledge-fault
  command; the state table does not change.
- Deferred to later ADRs: a time-based watchdog (two stages: warning at T_max,
  fault at 2×T_max), fault history and its retention, persisting `RETAIN` data
  in the browser and handling layout mismatches, start-up mode after reload,
  output behavior in STOP (OFF vs. hold), a program-visible emergency-stop
  status input with scanning continued, and Edition 4 features (`ASSERT`,
  `MUTEX`/`SEMA`).

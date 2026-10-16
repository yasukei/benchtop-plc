# 0009. Emergency stop overlays the operating state

- Status: Accepted
- Date: 2026-10-17
- Supersedes: [0005](0005-system-level-emergency-stop.md)

## Context

ADR 0005 requires emergency stop release to enter STOP. If emergency stop is a
replacement for FAULT, toggling it can bypass a latched fault and restart from a
partially executed scan. The maintainer clarified the operating-state contract
in [PR #26](https://github.com/yasukei/benchtop-plc/pull/26#discussion_r4298146012)
and updated issue #8 accordingly.

## Decision

Keep the operating state (STOP, RUN or FAULT) separate from the system-level
emergency stop flag. Activating the flag immediately cancels scanning and turns
all outputs OFF. While active, RUN and single-scan requests are rejected in every
operating state. The public core protocol reports ESTOP while the flag is active,
otherwise it reports the operating state; no protocol change is required.

Release never restarts the program: RUN becomes STOP, STOP stays STOP, and FAULT
stays FAULT with the same diagnostic. Only cold reset or loading a program clears
FAULT and its diagnostic and returns the operating state to STOP. Both operations
are allowed during emergency stop and leave the flag active until release.

## Consequences

Emergency stop cannot acknowledge a fault or permit a restart from a faulted
scan. A pending diagnostic remains available while ESTOP is reported. Hosts can
keep using the existing state protocol, and callers must explicitly request RUN
after emergency stop release or fault reset.

Emergency stop remains independent of the user program and is not readable by
ST in Milestone 1. The simulator is not a safety device.

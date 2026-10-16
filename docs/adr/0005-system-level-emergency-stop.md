# 0005. System-level emergency stop

- Status: Accepted
- Date: 2026-10-16

## Context
On real machines the emergency stop must not depend on the PLC program; it is implemented in hard-wired safety circuits (IEC 60204-1, ISO 13850). A simulator should teach the same habit.

## Decision
The emergency stop is handled by the runtime, not by the user program. Activating it stops scanning immediately and turns every output OFF. Releasing it moves the PLC to STOP; it never restarts automatically, and the user must press RUN again.

## Consequences
Users cannot implement or override the emergency stop in ST. Its state is not readable by the program in Milestone 1 (a status input can be added later as a separate decision). The simulator is not a safety device and must not be described as one.

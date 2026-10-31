# 0022. Operating states, overlays and command outcomes

- Status: Accepted
- Date: 2026-10-31
- Extends: [0009. Emergency stop overlays the operating state](0009-emergency-stop-overlay.md),
  [0010. Operating states, restarts and run-time errors](0010-operating-states-restarts-and-runtime-errors.md),
  [0016. Configurations, tasks, global variables and retentive variables](0016-configurations-tasks-and-global-variables.md),
  [0018. Debugging: instance selection, breakpoints and stepping](0018-debugging.md),
  [0020. Recover unexpected Worker errors as internal faults](0020-worker-error-recovery.md)
- Source: [issue #235](https://github.com/yasukei/benchtop-plc/issues/235)

## Context

The operating-state rules are spread across several ADRs. ADR 0010 lists a
run-time error in RUN but omits the same error during a single scan in STOP.
ADRs 0009 and 0010 use "rejected" for commands the implementation silently
ignores, whereas ADR 0018 uses it for a diagnostic-bearing protocol event.
ADR 0016 adds warm restart as a way to clear FAULT without explicitly extending
ADR 0009's earlier restriction. ADR 0020 adds internal-error faults in every
state and overlay. One table needs to record their combined, current behavior.

## Decision

This ADR consolidates the existing behavior; it changes no transition or command
response. In particular, it extends ADR 0009's fault-clearing rule: **warm
restart also clears FAULT**, including while E-STOP is active, and returns the
operating state to STOP. Cold reset and load still clear it as before. Warm
restart retains only the data specified by ADR 0016; none of these commands
implicitly starts RUN.

### States and notation

The operating state is STOP, RUN or FAULT. There are eight reachable combinations:

- `S`, `R`, `F`: STOP, RUN, FAULT with no overlay.
- `ES`, `ER`, `EF`: ESTOP over STOP, RUN, FAULT respectively.
- `HS`, `HR`: HALT over STOP, RUN respectively.

HALT over FAULT is unreachable. HALT and ESTOP never coexist: emergency stop
abandons a halt, and any fault ends it. The public state reports ESTOP first,
then HALT, then the operating state. Activating emergency stop over RUN keeps
the underlying RUN until stop, restart, load or release changes it; **release
changes that RUN to STOP**, never restarting execution. A fault stays latched
beneath ESTOP until a successful restart or load.

Each command cell explicitly identifies its disposition:

- `A:<state>`: **accepted**, with the resulting state combination shown above.
  `A:=` accepts the command and keeps the combination; its storage or scheduling
  effect still occurs.
- `I`: **ignored**; no execution or command effect, no `rejected` event, and no
  new fault. The state, diagnostic and memory stay unchanged. The Worker may
  still publish its current state, snapshot and an already latched diagnostic.
- `R:H` or `R:N`: **rejected**; no command effect or state change. The runtime
  throws `RuntimeCommandRejected`, which the Worker converts to a nonfatal
  `rejected` event naming the command. `H` means `runtime.halted`, and `N` means
  `runtime.not-halted`. A rejection never clears or replaces a latched fault.
- `R:C`: rejected with `runtime.configured-cycle`, with the same preservation
  rules.
- `E:<state>`: an error event latches the indicated fault state, stops scanning,
  abandons any halt or pending step, and turns outputs OFF.
- `—`: the event cannot occur there; no PLC body executes in FAULT or ESTOP.

The execution cells have program-dependent results:

- `A:scan`: run one scheduler pass in STOP. Successful completion stays `S`;
  a breakpoint gives `HS`, and a run-time error gives `F`.
- `A:resume`: continue the suspended pass. Successful completion returns to `S`
  from `HS`, or `R` from `HR`. Another breakpoint gives a halt over the same
  operating state, and an execution error gives `F`.
- `A:step`: resume toward the into/over/out target. Reaching a target or breakpoint
  gives a halt over the same operating state. Completing the single scan gives
  `S`; crossing a PROGRAM end over RUN can leave `R` with a step pending until a
  later statement. An execution error gives `F`.

### Command and error matrix

Commands arrive between execution slices through the Worker protocol. "Single
scan" means its `step` command, not the headless `scanOnce()` helper, which also
allows a pass in RUN. The table assumes a successfully loaded program and valid
arguments. "Set cycle" uses a supported implicit cycle; the explicit-configuration
row records its rejection and HALT's precedence. Load means a successful load;
an unexpected failure follows the internal-error row.

| Command or event     | S      | R    | F    | ES   | ER   | EF   | HS       | HR       |
| -------------------- | ------ | ---- | ---- | ---- | ---- | ---- | -------- | -------- |
| run                  | A:R    | I    | I    | I    | I    | I    | R:H      | R:H      |
| stop                 | A:S    | A:S  | A:F  | A:ES | A:ES | A:EF | A:S      | A:S      |
| single scan          | A:scan | I    | I    | I    | I    | I    | R:H      | R:H      |
| set cycle            | A:=    | A:=  | A:=  | A:=  | A:=  | A:=  | R:H      | R:H      |
| set cycle (explicit) | R:C    | R:C  | R:C  | R:C  | R:C  | R:C  | R:H      | R:H      |
| cold reset           | A:S    | A:S  | A:S  | A:ES | A:ES | A:ES | A:S      | A:S      |
| warm restart         | A:S    | A:S  | A:S  | A:ES | A:ES | A:ES | A:S      | A:S      |
| load                 | A:S    | A:S  | A:S  | A:ES | A:ES | A:ES | A:S      | A:S      |
| emergency stop       | A:ES   | A:ER | A:EF | I    | I    | I    | A:ES     | A:ER     |
| release              | I      | I    | I    | A:S  | A:S  | A:F  | I        | I        |
| continue             | R:N    | R:N  | R:N  | R:N  | R:N  | R:N  | A:resume | A:resume |
| debug step           | R:N    | R:N  | R:N  | R:N  | R:N  | R:N  | A:step   | A:step   |
| write                | A:=    | A:=  | A:=  | A:=  | A:=  | A:=  | A:=      | A:=      |
| force                | A:=    | A:=  | A:=  | A:=  | A:=  | A:=  | A:=      | A:=      |
| run-time error       | E:F    | E:F  | —    | —    | —    | —    | E:F      | E:F      |
| internal-error FAULT | E:F    | E:F  | E:F  | E:EF | E:EF | E:EF | E:F      | E:F      |

A run-time error or watchdog during **a single scan in STOP latches FAULT**, just
as during cyclic execution in RUN or execution resumed from HALT. This explicitly
extends ADR 0010's RUN-only error row. The diagnostic retains the source context
specified by the runtime contract. An unexpected Worker command/tick/publication
error instead uses `runtime.internal-error`, without source or exception text,
as ADR 0020 decides; it replaces any previous diagnostic even in FAULT. Both
fault kinds follow the same command rows. Fatal transport/startup failures remain
outside this PLC state machine (ADR 0020).

Expected argument validation failures are rejections in every operating state,
preserving the overlay and latched diagnostic. Invalid writes/forces use the
applicable `CommandRejectionCode` (including connected/input-mapped write
restrictions); force with a null value clears a force. Unsupported implicit
Worker cycles use `runtime.unsupported-cycle`; HALT takes precedence, then an
explicit configuration, then cycle-value validation. These failures do not
become internal-error faults.

Accepted write/force commands do not clear faults or resume execution. Writes
are queued in RUN and immediate otherwise, including while halted. A write to
a forced variable during HALT is consumed without changing its value. Forces
take effect at the next normal force stage. Outside HALT, debug commands cannot
energize output storage outside RUN; during HALT, writes can change output
storage but cannot publish a new output image. HALT over RUN holds the last
published image; HALT over STOP keeps the image OFF, as do FAULT and ESTOP. Stop,
emergency stop and faults preserve inspectable program storage, forces and
pending writes; restart/load clear forces and pending writes as ADR 0016 specifies.

## Consequences

- "Ignored" consistently means a silent no-op; "rejected" consistently means a
  nonfatal diagnostic-bearing command response. Earlier uses of "rejected" in
  ADRs 0009 and 0010 for run/single-scan requests in FAULT or ESTOP mean `I` here.
  These commands continue to be ignored rather than gaining new events.
- The table is checked directly by
  [the state-command conformance test](../../tests/conformance/state-commands.test.ts),
  including both language and internal faults, all three step kinds, and the
  STOP-to-FAULT and halt-abandonment paths. Worker event conversion and failure
  recovery are additionally covered by
  [worker-host tests](../../packages/web/src/worker-host.test.ts) and
  [worker-host error tests](../../packages/web/src/worker-host-errors.test.ts).
- The earlier ADRs remain unchanged. Their scheduling, retention, debugger and
  recovery details still apply; this ADR provides the combined transition and
  response vocabulary.

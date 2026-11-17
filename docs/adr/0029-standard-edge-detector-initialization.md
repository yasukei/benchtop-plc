# 0029. Standard edge-detector initialization

- Status: Accepted
- Date: 2026-11-17
- Partially supersedes: [0014](0014-user-defined-pous.md), Instance memory, restarts
  and faults (the R_TRIG first-call flag);
  [0016](0016-configurations-tasks-and-global-variables.md), Retentive variables
  (edge-detector private state)
- Source: [issue #229](https://github.com/yasukei/benchtop-plc/issues/229)

## Context

Issue #9 required both edge detectors to suppress their first-call pulse. ADR 0014
records a first-call flag, and ADR 0016 retains whether an edge detector has been
called. The maintainer has decided to follow IEC 61131-3 Ed. 3 instead.

The maintainer checked JIS B 3503:2016, 6.6.3.5.3, Table 44 and supplied these
standard definitions during implementation of #229:

```iecst
FUNCTION_BLOCK R_TRIG
    VAR_INPUT CLK: BOOL; END_VAR
    VAR_OUTPUT Q: BOOL; END_VAR
    VAR M: BOOL; END_VAR
    Q := CLK AND NOT M;
    M := CLK;
END_FUNCTION_BLOCK

FUNCTION_BLOCK F_TRIG
    VAR_INPUT CLK: BOOL; END_VAR
    VAR_OUTPUT Q: BOOL; END_VAR
    VAR M: BOOL; END_VAR
    Q := NOT CLK AND NOT M;
    M := NOT CLK;
END_FUNCTION_BLOCK
```

Both declarations leave the BOOL `M` at its default FALSE. Neither declares it
RETAIN. In F_TRIG, `M` stores NOT CLK, so FALSE-initialized `M` allows an initial
FALSE CLK to pulse Q. Initializing F_TRIG's M to TRUE would suppress that pulse
and would not match this definition.

Three bundled projects use the old suppression as a START interlock. The sorting
conveyor also depends on it to avoid recounting held sensors after restart.
Browser retained records from 0.8.0 encode a never-called trigger as
`{ previous: null }`; Boolean `previous` values store the last CLK for both blocks.

## Decision

- Execute the two standard bodies with private `M := FALSE`. The first call to
  R_TRIG pulses when CLK is TRUE; the first call to F_TRIG pulses when CLK is
  FALSE. Repeating the same CLK clears Q on the next call. There is no first-call
  suppression flag.
- Keep ADR 0016's qualifier inheritance. M has no intrinsic RETAIN qualifier:
  retaining the instance retains its ports and M together. An unqualified instance
  defaults to NON_RETAIN unless it inherits RETAIN from an enclosing composite.

| Operation                           | M and ports                                                        |
| ----------------------------------- | ------------------------------------------------------------------ |
| Load or cold reset                  | M and BOOL ports initialize to FALSE, including retained instances |
| Warm restart, non-retained instance | M and ports initialize to FALSE                                    |
| Warm restart, retained instance     | M and all ports are preserved                                      |
| STOP/RUN, single scans or FAULT     | Existing instance state is preserved                               |
| Retained reload                     | Initialize, then restore matching retained records                 |

- Preserve the retained-record shape without changing the core protocol. Encode
  `previous` as M for R_TRIG and NOT M for F_TRIG. After a call this is the sampled
  CLK, preserving the meaning of existing Boolean records. Accept legacy
  `previous: null` as M=FALSE for either block, with no skipped-path warning. New
  records contain a Boolean: a fresh R_TRIG saves FALSE and a fresh F_TRIG saves
  TRUE in this encoding. Validate the whole state before restoring any ports.
- Keep the examples' startup interlocks explicitly in ST. A non-retained
  `FirstScan : BOOL := TRUE` gates START pulses and the sorting conveyor's sensor
  pulses, then becomes FALSE after the PROGRAM body. Load, cold reset and warm
  restart rearm it. The trigger calls still run on the first activation so later
  held inputs do not create a second pulse. No system first-scan flag is added.

## Consequences

Accepted ST changes behavior on first calls and after non-retained restarts.
Code that needs startup suppression must express it explicitly. The three
examples preserve their existing operator behavior. Existing Boolean retained
histories keep their meaning, while legacy never-called records now produce the
standard's initial pulse. The decision bodies of ADR 0014 and ADR 0016 remain
unchanged as historical records. Their status metadata points to this decision,
which replaces only the rules identified above.

Conformance tests cover both initial CLK values, cold reset, retained and
non-retained warm restart, reload and legacy records. Example tests hold START
before the first task activation, verify it cannot start operation and then
verify a later edge. The existing sorting-conveyor trace remains unchanged.

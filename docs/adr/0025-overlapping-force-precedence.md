# 0025. Overlapping force precedence

- Status: Accepted
- Date: 2026-10-31
- Extends: [0016. Configurations, tasks, global variables and retentive variables](0016-configurations-tasks-and-global-variables.md)
- Source: [issue #238](https://github.com/yasukei/benchtop-plc/issues/238)

## Context

ADR 0016's Direct addresses decision makes overlapping located variables views of
one little-endian byte area. Its force stages restore forced values around image
transfers, parameter copies and instance execution, but do not define precedence
when two forces cover the same storage. Applying forces in their original
insertion order makes re-forcing a variable retain its old priority, so a newly
set force can be immediately hidden by an older force.

## Decision

Extend ADR 0016 with last-set precedence at every normal force stage:

- Apply active forces from oldest to newest. Where their addressed storage
  overlaps, the force most recently set wins. Setting an already forced variable
  again counts as a new set, even if its value is unchanged. A rejected force
  command changes neither the stored value nor precedence.
- Precedence applies only to shared bits. A BOOL force changes only its addressed
  bit; a byte or wider force changes its full addressed width. Bytes and bits
  outside the overlap retain the values supplied by their own forces or normal
  memory writes. Forces on distinct variables with disjoint storage keep their
  existing behavior.
- Every active variable remains marked forced even when a newer overlapping force
  prevents its full requested value from being visible. Snapshots show the shared
  memory value, and list forced IDs in ascending ID order, independently of
  precedence.
- Releasing a force removes only that force. At the next normal force stage,
  apply the remaining forces in their existing order, including to storage that
  the released force previously overrode. Do not restore any value from before
  forcing. Storage with no remaining force keeps its current value until an input
  refresh, program assignment or monitor write changes it.

Setting and releasing forces continue to change the force set immediately and
memory only at the next normal force stage, including during HALT (ADR 0018).
Existing image/parameter boundaries, within-instance writes and output clearing
outside RUN remain unchanged.

Event-task sampling uses the same last-set precedence for the sampled bit,
including a located global or a direct `%IX` input. Resolve active forces against
the sample before detecting its rising edge, even if a newly set force has not
reached a normal force stage yet. Without a covering force, sample a located input
from the fresh host input image and other globals from memory, as in ADR 0016.
Sampling does not apply forces to memory, consume pending writes or move any
normal task stage; an idle pass can therefore observe forces without running a task.

For example, force `wide AT %MW0 : WORD` to `16#1234`, then
`low AT %MB0 : BYTE` to `16#FF`. After a force stage, `wide` reads `16#12FF`
and `low` reads `16#FF`. Set the same word force again: the next stage gives
`wide = 16#1234` and `low = 16#34`, with both still marked forced. Release the
word force: the next stage restores the remaining byte force, yielding
`wide = 16#12FF` if nothing else wrote the high byte. If instead the byte force
is released while the word force remains, the next stage gives `16#1234`.

### Verification

[Direct-address conformance tests](../../tests/conformance/direct-addresses.test.ts)
cover both set orders, re-forcing with the same value, releasing either force in
either order, writes to released storage, rejected re-forces and byte/bit overlap.
They check values seen by the program and by snapshots, plus active force IDs.
[Task-scheduling conformance tests](../../tests/conformance/task-scheduling.test.ts)
cover matching event edges for overlapping memory/input forces, re-forces and
release, direct input events, idle sampling without memory changes and return to
the live input image when a covering force is released.

## Consequences

- Force precedence follows the latest accepted user command and is deterministic
  across every force stage; re-forcing can change overlapping values.
- A forced marker records an active request, not a guarantee that all of that
  variable's bits equal its requested value when another active force overlaps it.
- Releasing one force does not discard another force or roll memory back. The
  existing stages reassert the remaining requests without a new storage layer.

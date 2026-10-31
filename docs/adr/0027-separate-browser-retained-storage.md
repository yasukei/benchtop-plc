# 0027. Separate browser retained storage

- Status: Accepted
- Date: 2026-11-01
- Extends: [0016. Configurations, tasks, global variables and retentive variables](0016-configurations-tasks-and-global-variables.md)
- Supersedes: ADR 0016's storage of retained sets inside the workspace autosave record
- Source: [issue #249](https://github.com/yasukei/benchtop-plc/issues/249)

## Context

ADR 0016 stores a complete retained set in the browser autosave record. Updating
that set serializes every editable source, layout and project metadata, so the
cost grows with workspace size even when no editable work changes.

## Decision

- Keep editable work in the version 4 record at `benchtop-plc.work`. Store the
  complete retained array separately at `benchtop-plc.retentive` in `localStorage`.
  Retained updates save immediately without rewriting editable work or moving its
  500 ms save deadline.
- The separate key takes precedence over embedded legacy records whenever it is
  present, including when it contains `null`, malformed JSON or an invalid value.
  `null` records that a replacement project cleared retention, preventing old
  embedded values from returning. An empty array is a complete empty retained set.
- When the separate key is absent, validate and restore the embedded legacy array
  and migrate it on first load. Leave the original workspace intact during this
  migration. If the separate write fails, later workspace saves keep an embedded
  fallback until a separate write succeeds; normal workspace saves omit retention.
- Validate arrays record by record before passing them to the runtime. Discard
  malformed records while preserving valid leaves and whole block records. An
  entirely malformed array becomes an empty restore set, so expected paths still
  produce the runtime's existing unrestored-path warning. Non-array or unreadable
  retention does not prevent restoring editable work.
- Sampling remains limited to once per second during ordinary execution, including
  when values are unchanged. Lifecycle publications remain immediate. Retained
  storage semantics, matching paths and types, restart behavior and the exclusion
  of retention from project XML continue to follow ADR 0016.

## Consequences

Retained changes serialize only retained records, independently of workspace size.
Existing autosaves restore retained values without a format-version change.
Storage now has two keys with explicit precedence and a clearing marker; quota
failures during migration retain the legacy fallback. As before, a reload can lose
about one second of retained changes, and unavailable storage raises a warning
without stopping execution.

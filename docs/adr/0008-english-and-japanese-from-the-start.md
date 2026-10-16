# 0008. English and Japanese from the start

- Status: Accepted
- Date: 2026-10-16

## Context
The author is Japanese-speaking and the project is public. Adding translations later means hunting hard-coded strings across the UI.

## Decision
Support English (default) and Japanese from the first UI issue. Every user-facing string goes through the i18n catalog. Tests check that both catalogs have the same keys and that every diagnostic code has a message. ST keywords and IEC terms are not translated.

## Consequences
Every UI change touches two catalogs. Adding a third language later is mechanical.

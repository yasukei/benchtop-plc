# 0004. Diagnostics as codes with arguments

- Status: Accepted
- Date: 2026-10-16

## Context
The UI supports several languages. The prototype built error text inside the compiler, which ties the compiler to one language and makes errors hard to assert in tests.

## Decision
The compiler and runtime report diagnostics as a stable code, a severity, a source span and typed arguments. They never produce user-facing text. The UI renders messages from the i18n catalog.

## Consequences
Tests assert codes and spans instead of strings. Messages can be translated and reworded without touching the engine. Every new error needs a code, documentation in `docs/diagnostics.md`, and messages in every UI language.

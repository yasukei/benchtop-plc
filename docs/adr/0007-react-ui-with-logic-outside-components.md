# 0007. React UI with logic outside components

- Status: Accepted
- Date: 2026-10-16

## Context
The UI is built mostly by coding agents. It must be well structured and testable.

## Decision
Use React with TypeScript. Keep logic out of components: runtime communication, application state and panel layout logic are plain TypeScript modules with unit tests. Components render state and forward events. The ST editor uses CodeMirror 6 wrapped in a thin component.

## Consequences
Agents work with a widely used stack, and most behaviour is testable without a browser. Some code that could live in hooks lives in modules instead, which adds a little plumbing.

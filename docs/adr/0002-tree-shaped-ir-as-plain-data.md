# 0002. Tree-shaped IR as plain data

- Status: Accepted
- Date: 2026-10-16

## Context
The prototype compiled ST directly into JavaScript closures. Closures cannot be sent to a Web Worker, saved, inspected in tests, or mapped back to source for debugging. Ladder will need to share the execution engine with ST.

## Decision
Compile every language into one intermediate representation (IR) that is a tree: fully typed, names resolved, every node carrying a source span. The IR is plain JSON-serializable data (no functions or class instances). The runtime may convert it internally into a faster form.

## Consequences
IR can be posted to a Worker, snapshot-tested as JSON, and used for inline values and future breakpoints. ST and Ladder share one runtime. A tree is slower to interpret than bytecode; a bytecode stage can be added later for constrained devices without changing the compilers.

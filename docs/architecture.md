# Architecture

benchtop-plc is a browser-based software PLC that aims at IEC 61131-3 compliance.
A user writes a program, places I/O parts on an operator panel, runs the program in
scan cycles and debugs it, all inside the browser.

## Packages

| Package | Responsibility | May depend on |
|---|---|---|
| `core` | Data types, tree IR, UI⇔runtime protocol, diagnostic codes, standard FB/function descriptors | – |
| `compiler` | Source (ST) → AST → checked AST → IR | `core` |
| `runtime` | Executes IR in scan cycles; standard FB/function implementations; debug features | `core` |
| `project` | Project model; PLCopen XML (TC6 v2.01) read/write | `core`, `compiler` (declaration parsing and initializer validation) |
| `web` | React UI; hosts the runtime in a Web Worker | all of the above |

`compiler`, `runtime`, `project` and `core` do not use DOM APIs, so they run in Node, in a
Web Worker, and later on a device.

Project imports and exports reuse the compiler to validate scalar initializer
expressions against their declared types, as required by
[ADR 0012](adr/0012-elementary-data-types.md).

The compiler semantic-checking API is documented in [type-checking.md](type-checking.md).
The complete source-to-IR API is documented in [compiler.md](compiler.md).
Current language support and implementation-dependent choices are documented in
[compliance.md](compliance.md).

Milestone 4's accepted model for user-defined POUs, parameter passing, instance
memory, project exchange and monitoring is recorded in
[ADR 0014](adr/0014-user-defined-pous.md). Its implementation is tracked by the
sub-issues of [#93](https://github.com/yasukei/benchtop-plc/issues/93).

Milestone 5's accepted model for data type declarations, enumerations, subranges,
arrays, structures, strings and references, including their run-time errors,
monitoring and PLCopen XML mapping, is recorded in
[ADR 0015](adr/0015-derived-types-strings-and-references.md). Its implementation is
tracked by the sub-issues of [#118](https://github.com/yasukei/benchtop-plc/issues/118).

## Data flow

```
 editor text ──► compiler ──► IR (plain data) ──► runtime (Web Worker)
      ▲              │                               │
      │         diagnostics                    snapshots, faults
      │        (code + args)                  (values, annotations)
      │              ▼                               ▼
      └──────────── web UI ◄──── i18n catalog (en, ja) renders messages
                     │
                     ▼
               project ◄──► PLCopen XML file (panel layout in addData)
```

## Scan cycle

Each scan: read the input image → apply pending writes → apply forces → execute the
program → apply forces → write the output image. Time comes from an injected `Clock`.
Operating states are `STOP`, `RUN` and `FAULT`. An independent emergency stop flag
overlays the operating state and reports `ESTOP` while active. Every reported state
except `RUN` keeps outputs OFF. Releasing emergency stop preserves a pending FAULT;
otherwise it leaves STOP without restarting. See [ADR 0009](adr/0009-emergency-stop-overlay.md).
Operating-state transitions, restart semantics and run-time error reactions are
recorded in [ADR 0010](adr/0010-operating-states-restarts-and-runtime-errors.md).

## Testing

1. Unit tests per package (Vitest).
2. Conformance tests in `tests/conformance/`: a program plus a trace of inputs and expected
   values over virtual time.
3. End-to-end tests in `packages/web/e2e/` (Playwright).

## Decisions

Design decisions and their reasons are recorded in [`adr/`](adr/).

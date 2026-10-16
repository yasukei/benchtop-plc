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
| `project` | Project model; PLCopen XML (TC6 v2.01) read/write | `core`, `compiler` (declaration parsing only) |
| `web` | React UI; hosts the runtime in a Web Worker | all of the above |

`compiler`, `runtime`, `project` and `core` do not use DOM APIs, so they run in Node, in a
Web Worker, and later on a device.

The compiler semantic-checking API is documented in [type-checking.md](type-checking.md).
The complete source-to-IR API is documented in [compiler.md](compiler.md).

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
States are `STOP`, `RUN`, `ESTOP` and `FAULT`; every state except `RUN` keeps outputs OFF.

## Testing

1. Unit tests per package (Vitest).
2. Conformance tests in `tests/conformance/`: a program plus a trace of inputs and expected
   values over virtual time.
3. End-to-end tests in `packages/web/e2e/` (Playwright).

## Decisions

Design decisions and their reasons are recorded in [`adr/`](adr/).

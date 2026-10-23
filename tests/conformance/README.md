# Data-driven conformance tests

Run `pnpm test` to include all cases, or
`pnpm test tests/conformance/traces.test.ts` to run only the data-driven suite.
Each immediate subdirectory except `fixtures/` is a case containing `program.st`
and `trace.json`, optionally with further `.st` files for function POUs. The
runner compiles every `.st` file together in filename order (one POU per file).
Cases are discovered in name order; a missing trace fails the suite. Existing TypeScript conformance tests and golden IR stay alongside them.

## Execution traces

```json
{
  "kind": "run",
  "cycleMs": 10,
  "steps": [
    {
      "label": "Start the controller",
      "set": { "StartPB": true },
      "scans": 1,
      "expect": { "Running": true, "tBlinkOn.ET": 0 }
    },
    {
      "label": "Complete the on delay",
      "set": { "StartPB": false },
      "advanceMs": 500,
      "expect": { "Lamp": true, "Blinks": 1 }
    }
  ]
}
```

The harness compiles the source without diagnostics, creates a fresh runtime with
a `VirtualClock` and `VirtualTicker`, and enters RUN at virtual time zero. The
first scan occurs at `cycleMs`, not at zero. The cycle must be positive and finite.
Every due scan executes chronologically; advancing time never skips scans.
No wall clock or real-time waits are involved.

Steps execute in array order:

1. `set` optionally changes mapped BOOL inputs or queues scalar variable writes.
   Mapped inputs stay at their assigned levels until changed. Scalar writes apply
   once, before program execution on the next scan, and remain pending if no scan
   occurs. Output-mapped variables and FB ports cannot be set. BOOL values must be
   JSON booleans; character values and 64-bit values use JSON strings, and other
   scalar values use finite JSON numbers. Scalar
   writes use the runtime's normal assignment coercion.
2. `scans: N` advances virtual time by `N * cycleMs`; N must be a nonnegative safe
   integer. Alternatively, `advanceMs` advances by a nonnegative finite duration,
   including durations between ticks. Ticker phase is preserved between steps.
   With neither field, time does not advance (useful for initial expectations).
3. `expect` checks the snapshot after the advance. It must be nonempty. Keys are
   case-insensitive scalar names or FB members such as `Timer.Q`, `Timer.ET`,
   `Up.CV` or `Timer.IN`. Booleans, strings and numbers compare exactly; TIME uses integer
   milliseconds. Expectations only inspect values and never execute a scan.

Every step needs a nonempty `label`. Unknown fields, names, FB members, invalid
values, compile failures and runtime faults fail the case. `scans` and `advanceMs`
are mutually exclusive. A mismatch includes the case, one-based step number,
label, variable, expected/actual values, virtual time and scan count, for example:

```text
wrong-expectation: step 1 (check): Error: variable Count: expected 99, actual 1 at 10 ms (scan 1)
```

`trace.test.ts` verifies this failure path with an intentionally wrong expectation.
To see Vitest's failure report, temporarily change an expectation in a case and run
the suite; restore the value afterward. Trace validation and execution helpers
live in `trace.ts`; add cases as data without changing the runner.

## Negative compilation traces

```json
{
  "kind": "compile-error",
  "diagnostics": ["name.undeclared"]
}
```

Compilation must fail with no IR and exactly the listed diagnostic codes,
including duplicates, in any order. Unexpected additional diagnostics fail the
case. Negative traces have no cycle or steps and never start a runtime.

## Reference example

`reference/program.st` is the same reference source as `fixtures/reference.st`.
Its 10 ms trace checks start/release, the 500 ms timer boundaries, the first,
ninth and tenth lamp edges, alarm reset, stop/release and simultaneous start/stop.
The first lamp edge occurs at 510 ms; subsequent edges are 1020 ms apart because
the two sequential TON calls need a scan to reset and another to start timing again. Expectations capture this scan
ordering explicitly.

[`examples/blink/project.xml`](../../examples/blink/project.xml) is a checked-in
PLCopen TC6 v2.01 project with the exact reference source and a 10 ms cyclic task.
The example test imports it with `readProject`, checks the source and interval,
then compiles and executes the same reference trace. No panel layout is required.

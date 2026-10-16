# Headless runtime

`@benchtop-plc/runtime` executes compiler-checked, plain-data `ProgramIR` without
host APIs. The caller owns the program and must not mutate it while loaded.

```ts
import { createRuntime, VirtualClock, VirtualTicker } from "@benchtop-plc/runtime";

const clock = new VirtualClock();
const runtime = createRuntime({ clock, ticker: new VirtualTicker(clock) });
runtime.load(ir);
runtime.run();
clock.advance(30); // Three scans at the default 10 ms cycle.
const snapshot = runtime.snapshot();
runtime.stop();
```

The host injects a monotonic `Clock.now()` in milliseconds and a
`Ticker.start(intervalMs, callback)` returning an idempotent cancellation function.
The cycle is configured with a positive finite `intervalMs` at construction.
RUN is idempotent and starts scans on ticks, without an immediate initial scan.
The virtual clock dispatches every due callback chronologically, breaking ties by
registration order. Cancellation and registrations during callbacks take effect
immediately. Nested `advance` calls are rejected. Production clock/ticker adapters
belong to the Worker host (#12).

## Scan and state

`ScanStages` supplies the input/output image boundary and extension points for
pending writes and forces. The sequence is read inputs, copy mapped inputs into
memory, apply pending writes, apply forces, interpret the body, apply forces again,
then publish mapped outputs. `ScanMemory.write` uses the declaration's core
coercion helper. The debug command API and force tracking are deferred to #10;
`forced` is currently empty. Input/output callbacks receive copied images.

`scanOnce()` executes a complete scan in STOP or RUN, unless already scanning.
ESTOP and FAULT ignore scans and RUN requests. STOP scans update internal state
and annotations while keeping output-mapped variables and output images OFF.
The later protocol `step` handler (#10) must restrict its command to STOP.

The operating state is STOP, RUN or FAULT. Emergency stop is an independent
system-level flag over that state, as recorded in [ADR 0009](adr/0009-emergency-stop-overlay.md).
The public `state` reports ESTOP while the flag is active, otherwise the operating
state. A pending FAULT and its `diagnostic` remain latched beneath ESTOP.

`stop()` cancels cyclic execution and de-energizes output variables and the output
image while preserving any pending FAULT and the emergency stop flag.
`setEmergencyStop(true)` stops scanning immediately and de-energizes outputs;
RUN and single-scan requests are ignored while the flag is active, in every
operating state. `setEmergencyStop(false)` releases the flag without restarting:

| Operating state before release | After release | Diagnostic              |
| ------------------------------ | ------------- | ----------------------- |
| RUN                            | STOP          | None                    |
| STOP                           | STOP          | None                    |
| FAULT                          | FAULT         | Same pending diagnostic |

Only cold reset or loading a program clears FAULT and its diagnostic. Both are
allowed while emergency stop is active: they reset the operating state to STOP
and clear the fault, while the public state remains ESTOP until release. Release
then reports STOP; a later RUN request is required to start execution.

`load` initializes a new program; `coldReset` recreates all variables and FB
instances. Both clear diagnostics, annotations and scan counters and keep outputs
OFF. Loading/resetting during a scan is rejected. A stop during a host/library
callback aborts the remaining scan stages; an emergency stop stays active even if
the interrupted computation subsequently faults. Stale ticker callbacks cannot
restart scans. Outputs stay OFF in every reported state except RUN, including
when output declarations have TRUE initial values.

## Execution and diagnostics

All IR expressions and statements are supported. Both binary operands and function
arguments are evaluated in source order. Operators use the IR result type for
coercion; real literals and their unary signs preserve binary64 precision until
an operator or destination coercion, matching compiler semantics. Integer division
truncates toward zero; integer arithmetic and assignments wrap through core helpers.
FOR evaluates its bounds and step once on entry, assigns its control variable,
and compares its current value inclusively on each iteration. Its increment is
coerced like an assignment; an overflowing control variable can reach the watchdog.
EXIT leaves the innermost loop; RETURN leaves the program for that scan.

The shared scan watchdog allows 200,000 total loop-body iterations, including
nested loops, and faults on iteration 200,001. It reports the offending loop span.
Zero division/MOD reports the expression span; zero FOR step reports the step
expression span. Non-finite values and REAL overflow use `runtime.invalid-value`
at the innermost expression or assignment/FB call that detected the invalid value.
These faults cancel the ticker, clear outputs, latch FAULT and expose a copied
`diagnostic`. Cold reset or loading a program clears FAULT.

Unexpected host/library programming errors also clear outputs and latch FAULT,
then propagate to the host; they are not PLC-language diagnostics.

## Standard library integration

Pass a `RuntimeLibrary` for programs using functions or FBs. It supplies function
results and creates independent FB instances with typed input/output port arrays
in core descriptor order. Each instance owns its private state and receives the
same scan-start time on every call in a scan. FB input assignments and named call
inputs coerce to the input port type; omitted inputs retain their previous values.
FB outputs and function results are coerced before use. Cold reset requests fresh
instances. The standard implementations and shared descriptors belong to #9.

## Snapshots

Snapshots are detached, JSON-serializable copies with images, variables, count,
and execution duration measured by the injected clock. Annotations follow the
[core protocol](core-contracts.md): one entry per executed assignment or FB call,
using its last execution's values, grouped by line and sorted by column. Values
reflect that statement's execution, before any later assignment or force. Each
scan starts with empty annotations; partially executed scans retain only completed
statements. `snapshot()` does not execute the program.

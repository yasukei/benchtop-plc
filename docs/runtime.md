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

Operating-state transitions, restart semantics and run-time error reactions are
defined in [ADR 0010](adr/0010-operating-states-restarts-and-runtime-errors.md).
STOP → RUN resumes with existing variable and FB state; cold reset or loading a
program initializes it. Outputs remain subject to the state rules below.

`ScanStages` supplies the input/output image boundary and extension points for
pending writes and forces. The sequence is read inputs, copy mapped inputs into
memory, apply pending writes, apply forces, interpret the body, apply forces again,
then publish mapped outputs. `ScanMemory.write` uses the declaration's core
coercion helper. Built-in debug writes run before the pending-write extension;
built-in forces run before the pre-execution force extension and after the
post-execution force extension, so the built-in force wins in the final image.
Input/output callbacks receive copied images.

`scanOnce()` executes a complete scan in STOP or RUN, unless already scanning.
ESTOP and FAULT ignore scans and RUN requests. STOP scans update internal state
and annotations while keeping output-mapped variables and output images OFF.
`step()` executes exactly one scan only in STOP and returns the current snapshot
without execution in every other state. It uses the same injected clock as cyclic
execution; it does not advance virtual time on the caller's behalf. The Worker
routes the core protocol's `step` command to this method.

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

## Debug commands

`force(variableId, typedValue)` sets or replaces a scalar force, including mapped
inputs and outputs. `force(variableId, null)` clears it; clearing an unforced
scalar is a no-op. Changes take effect on the next scan, with forces applied after
reading inputs/pending writes and again after executing the program. Clearing a
force returns control to the input image or program on subsequent scans; it does
not restore an old value. The snapshot's `forced` array contains the active IDs
in ascending order, even while stopped or emergency-stopped.

`write(variableId, typedValue)` writes once at the start of the next scan while
RUN, or immediately while stopped. Multiple pending writes to a variable use the
last value. Pending writes survive STOP until a later scan; an immediate write
to the same variable replaces its pending write. Writes issued after the scan's
pending-write stage are queued for the following scan. A force takes priority over a write,
and that write is still consumed. Loading or cold reset clears all pending writes
and forces.

Both commands require a loaded scalar ID and the declaration's exact `dataType`.
Accepted external values are checked against their type before being copied.
Out-of-range integers and noncanonical long strings are rejected without wrapping. Unknown/FB targets, mismatched types, malformed values and non-finite
numbers throw `RuntimeCommandRejected` before changing memory or the debug sets.
Its `diagnostic` contains a stable command-rejection code and arguments.
Input-mapped variables
reject writes because the next input image would overwrite them; they accept
forces. Commands cannot energize output variables/images outside RUN, including
immediate writes in STOP, FAULT or ESTOP. The Worker host routes the existing core
`force` and `write` messages and publishes updated snapshots after accepted
commands. The Worker host catches only `RuntimeCommandRejected` and sends a
non-fatal core `rejected` event with the command type and diagnostic. The existing
state, memory, forces, pending writes, ticker and connection remain intact; this
does not latch a PLC fault or replace a pending fault diagnostic. Unexpected
programming errors still propagate to the host.

## Execution and diagnostics

All IR expressions and statements are supported. Both binary operands and function
arguments are evaluated in source order. Operators use the IR result type for
coercion; every REAL result is binary32 and LREAL results preserve binary64
precision, matching compiler semantics. Integer division
truncates toward zero; MOD with a zero divisor returns zero. Integer arithmetic
and assignments wrap through core helpers.
LINT, ULINT, LWORD and LTIME memory cells use bigint. Literal/initial values and
debug messages carry canonical decimal strings; snapshots and annotations convert
back to strings without passing through JavaScript numbers. Long IR literals are
validated on load, including literals in branches that will not execute. Long
arithmetic wraps to 64 bits; LWORD bit masks cover bits 0–63.
LTIME counts nanoseconds: real scaling uses the exact binary fraction and rounds
once, nearest with ties to even, before wrapping. Integer scaling truncates
division toward zero. TIME widens to LTIME by multiplying by 1,000,000.

FOR evaluates its bounds and step once on entry, assigns its control variable,
and compares its current value inclusively on each iteration. Its increment is
coerced like an assignment; an overflowing control variable can reach the watchdog.
EXIT leaves the innermost loop; RETURN leaves the program for that scan.

The shared scan watchdog allows 200,000 total loop-body iterations, including
nested loops, and faults on iteration 200,001. It reports the offending loop span.
Division by zero reports the expression span; zero FOR step reports the step
expression span. Non-finite values and REAL overflow use `runtime.invalid-value`
at the innermost expression or assignment/FB call that detected the invalid value.
These faults cancel the ticker, clear outputs, latch FAULT and expose a copied
`diagnostic`. Cold reset or loading a program clears FAULT.

Unexpected host/library programming errors also clear outputs and latch FAULT,
then propagate to the host; they are not PLC-language diagnostics.

## Standard library integration

`createRuntime` uses `standardLibrary` by default. Pass a custom `RuntimeLibrary`
to replace dispatch. The library supplies function results and creates independent
FB instances with typed input/output port arrays in core's
`standardFunctionBlocks` descriptor order. Each instance owns its private state
and receives the same scan-start time on every call in a scan. FB input assignments
and named call inputs coerce to the input port type; omitted inputs retain their
previous values. FB outputs and function results are coerced before use. Cold
reset requests fresh instances. `createStandardFunctionBlock(type)` and
`callStandardFunction(name, args, dataType?)` also expose the implementations directly;
direct callers supply compiler-checked, typed/coerced inputs. Polymorphic function
results require coercion to the result type, as performed by the interpreter.
The interpreter passes the IR result type as the optional third dispatch argument;
direct callers must provide it for shifts/rotates and for type-specific arithmetic
wrapping or REAL intermediate rounding. Existing two-argument custom dispatchers
remain compatible.

### Timers and edges

TON starts when called with IN=TRUE, sets Q at elapsed time >= PT and resets Q/ET
when IN=FALSE. TOF sets Q immediately on IN=TRUE, starts its delay on the falling
edge and clears Q at PT. A new TRUE cancels that delay and resets ET. Initial
IN=FALSE does not start a TOF delay. TP starts on a rising edge (including initial
IN=TRUE), keeps Q TRUE until PT even if IN falls, and ignores edges during the
pulse. After completion it needs IN=FALSE before accepting another rising edge.

ET is integer milliseconds, clamped to PT. TON/TOF retain ET=PT after completion
until reset; TP retains it while IN stays TRUE and resets it to zero once the
pulse is complete and IN=FALSE. Nonpositive PT acts as zero: TON completes
immediately, TOF has no off delay and TP emits no pulse. PT is sampled on every
call while timing; completion stays latched until the corresponding reset, so
increasing PT after completion cannot restart an output. Completed ET follows PT.
Timers read no clock themselves; all elapsed times use the supplied scan start.

R_TRIG/F_TRIG compare CLK with its previous call and emit Q for one call on the
corresponding edge. Both suppress a pulse on their first call, regardless of CLK.

### Counters and functions

CTU increments CV on CU rising edges and sets Q when CV >= PV. R resets CV to
zero. CTD loads PV while LD=TRUE, otherwise decrements on CD rising edges, with
Q when CV <= 0 (including its initial zero state). Counts continue beyond PV/zero
and saturate at the INT limits, 32767/-32768. Reset/load takes priority over an
edge but still samples CU/CD, so releasing it at a held-high level does not count.
Counters initially remember FALSE, so an initial TRUE counts unless reset/loading.
This difference from R_TRIG is intentional: counters retain FALSE-initialized edge
memory, while issue #9 explicitly requires first-call pulse suppression for the
standalone R_TRIG/F_TRIG blocks. Cold reset restores each block's own startup rule.

ABS operates on all numeric types. SQRT, LN, LOG (base 10), EXP, SIN, COS, TAN,
ASIN, ACOS and ATAN operate on REAL/LREAL. Trigonometric arguments/results use
radians; ATAN2(y, x) selects the quadrant. EXPT and `**` keep the real base's type
and accept an independently typed numeric exponent. Non-finite results fault at
the call or operator span with `runtime.invalid-value`.

ADD and MUL accept two or more numeric arguments; SUB and DIV take two, and MOD
takes two integer arguments. Integer arithmetic is exact before width-based
wrapping, including 64-bit operands and 32-bit multiplication. DIV truncates
integer results toward zero and division by zero faults with
`runtime.division-by-zero`. MOD has the dividend's sign and MOD(x, 0) is zero.
REAL results round to binary32 at each intermediate addition/multiplication.

SHL/SHR/ROL/ROR operate at the value's width (BOOL is one bit) with an independent
integer count. Shifts zero-fill; counts at or above the width return zero.
Rotations reduce the count modulo the width. Negative counts fault with
`runtime.invalid-value`. All 64 bits of LWORD are preserved. AND, OR and XOR
are extensible; NOT takes one argument. Both call and operator forms accept
BOOL/bit strings and preserve their common bit type.

MIN, MAX and LIMIT accept all compatible elementary values, including BOOL
(FALSE < TRUE), bit strings, durations and chronological calendar values. LIMIT(MN, IN, MX) evaluates
`MIN(MAX(IN, MN), MX)`, including when bounds are reversed. SEL(G, IN0, IN1)
returns IN0 for FALSE and IN1 for TRUE. MUX(K, IN0, IN1, ...) selects the
zero-based Kth value. An out-of-range K (including a negative value) faults with
`runtime.invalid-value`; this is an implementation-dependent choice. MOVE returns
its single argument. GT/GE/EQ/LE/LT require every adjacent comparison to hold;
NE takes exactly two values. Generic values use the ADR 0013 common type.
All function arguments, including unselected SEL/MUX values, evaluate eagerly.

TRUNC_<integer> and REAL_TRUNC_<integer>/LREAL_TRUNC_<integer> truncate toward
zero, then wrap. They preserve source real precision before truncation.
<bit-string>_BCD_TO_<integer> decodes packed unsigned decimal digits (four bits
per digit); any nibble above nine faults with `runtime.invalid-value`.
<integer>_TO_BCD_<bit-string> encodes a nonnegative integer; a negative input
faults. Results wrap to the destination width, retaining the low decimal digits
when an encoded result exceeds the bit-string width. All integer/bit-string pairs
are available, including LWORD/ULINT. These calls are not constant expressions.

Numeric conversions exist for every distinct ordered pair of supported integer
and real types, with overloaded TO_<type> forms. LREAL ↔ LWORD reinterprets the
binary64 pattern; nonfinite patterns fault. LTIME ↔ integer extensions count
nanoseconds; TIME ↔ LINT/ULINT extensions count milliseconds.
LTIME_TO_TIME truncates toward zero before wrapping to signed 32-bit milliseconds. Integer → integer
wraps. Real → integer rounds nearest, ties to even (2.5 → 2, 3.5 → 4, -2.5 → -2),
then wraps: REAL_TO_INT(40000.0) and DINT_TO_INT(40000) are -25536. Integer → real
and LREAL → REAL round nearest, ties to even. REAL source values and every REAL
operator result, including unary signs, are binary32; LREAL arithmetic keeps
binary64 precision. Non-finite results and REAL overflow fault with
`runtime.invalid-value`.

BOOL_TO_INT/DINT/UINT return 0/1. TIME_TO_INT/DINT/UINT and INT/DINT/UINT_TO_TIME
(and their overloaded forms) are extensions using milliseconds without scaling;
integer destinations wrap, so TIME_TO_INT(T#40s) is -25536. TIME is signed 32-bit milliseconds; arithmetic wraps, while out-of-range external
TIME values are rejected. Real scaling rounds once from the exact result to nearest
milliseconds, ties to even; integer division truncates toward zero. No conversion to BOOL, BOOL → real or TIME → real exists.
Polymorphic integer results wrap, so ABS(INT_MIN) remains INT_MIN. Negative zero
normalizes to zero for every numeric type.

## Snapshots

Snapshots are detached, JSON-serializable copies with images, scalar values, FB
inputs/outputs, the active forced IDs, count,
and execution duration measured by the injected clock. Annotations follow the
[core protocol](core-contracts.md): one entry per executed assignment or FB call,
using its last execution's values, grouped by line and sorted by column. Values
reflect that statement's execution, before any later assignment or force. Each
scan starts with empty annotations; partially executed scans retain only completed
statements. `snapshot()` does not execute the program.

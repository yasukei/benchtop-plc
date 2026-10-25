# Headless runtime

`@benchtop-plc/runtime` executes compiler-checked, plain-data `ConfigurationIR` without
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
Loading a configuration sets the tick to the greatest common divisor of its cyclic
intervals (10 ms for event-only configurations). Standalone
legacy `ProgramIR` uses the positive finite `intervalMs` construction option.
`setCycle(ms)` changes an implicit configuration's cycle, preserving memory and
restarting the ticker when running. An explicit configuration rejects it with
`runtime.configured-cycle`; edit its source to change the interval.
RUN is idempotent and starts scans on ticks, without an immediate initial scan.
The virtual clock dispatches every due callback chronologically, breaking ties by
registration order. Cancellation and registrations during callbacks take effect
immediately. Nested `advance` calls are rejected. Production clock/ticker adapters
belong to the Worker host (#12).

## Task scheduling

A resource has 1–16 cyclic or event tasks. Cyclic tasks use a TIME/LTIME literal
from 10 ms to 1 h in whole 10 ms steps. Event tasks use `SINGLE := globalBool`
(a non-constant BOOL global, including a BOOL alias) or a supported `%IX0.0`–`%IX63.7`
address. Each task requires a literal priority from 0 to 65535; 0 is highest.
Exactly one of INTERVAL and SINGLE is required. Every PROGRAM instance uses WITH
to bind to one task; instances within that task run in resource declaration order.

Each tick starts a non-preemptive pass. Readiness is fixed at pass start. Ready
tasks run by priority, then earliest due time or sampled edge, then task declaration
order. Cyclic tasks are first due one interval after RUN. STOP → RUN restarts those
due times, preserving memory and event samples. A task becoming ready during a pass
waits for the next pass.

Every pass samples all event inputs, including single scans and passes without a
ready cyclic task. A FALSE → TRUE transition runs the event task once. Nothing is
sampled while stopped without a single scan, so an edge arriving during STOP is
seen on the first subsequent pass. Load and cold reset clear samples to FALSE;
STOP → RUN retains them. An event-only resource ticks every 10 ms. Global values
are sampled before task writes; located input globals and direct inputs use the
live host input image. Pending monitor writes are consumed at the next task run,
so they affect a global event sample on a subsequent pass.

After a cyclic run, the next due time advances from its prior due time by one
interval. Activations at or before the finish time are skipped and counted as
overruns, without a fault or catch-up execution. A 10 ms task due at 10 ms that
finishes at 35 ms has two overruns and is next due at 40 ms.

`snapshot.tasks` reports task name, run count, last and maximum execution time in
milliseconds from the injected Clock, and overruns, in declaration order. Load and
cold reset clear these statistics. The Worker publishes them with every snapshot.
`scanCount` counts passes in which at least one task ran; idle event samples do not
increase it. Single scans run every cyclic task once and only rising event tasks,
without counting overruns. A fault, STOP or emergency stop halts the entire resource.
The 200,000-iteration limit applies independently to each task run.

## Scan and state

Operating-state transitions, restart semantics and run-time error reactions are
defined in [ADR 0010](adr/0010-operating-states-restarts-and-runtime-errors.md).
STOP → RUN resumes with existing variable and FB state; cold reset or loading a
program initializes it. Outputs remain subject to the state rules below.

`ScanStages` supplies the input/output image boundary and extension points for
pending writes and forces. For each ready task in scheduler order, read inputs,
copy mapped inputs into memory, consume pending writes, apply forces, and then
execute its program instances in resource declaration order. For each instance: copy connected inputs, apply forces,
execute, apply forces, copy connected outputs, apply forces. Publish mapped outputs
after the last instance of each task. Each instance aliases its own persistent storage onto a shared
PROGRAM body, refreshing only that instance's temporaries. A single task budget
counts loop iterations across all its instances. A fault stops later instances
and faults the whole resource, naming its task, POU and qualified instance path. `ScanMemory.write` uses the declaration's core
coercion helper. Built-in debug writes run before the pending-write extension;
built-in forces run before the pre-execution force extension and after the
post-execution force extension, so the built-in force wins in the final image.
Input/output callbacks receive copied images.

`scanOnce()` executes one single-scan pass in STOP or RUN, unless already scanning.
ESTOP and FAULT ignore scans and RUN requests. STOP scans update internal state
and annotations while keeping output-mapped variables and output images OFF.
`step()` executes exactly one pass only in STOP and returns the current snapshot
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

Warm restart, cold reset or loading a program clears FAULT and its diagnostic. All are
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
reading inputs/pending writes and after each parameter copy and instance execution. Clearing a
force returns control to the input image or program on subsequent scans; it does
not restore an old value. The snapshot's `forced` array contains the active IDs
in ascending order, even while stopped or emergency-stopped.

`write(variableId, typedValue)` rejects connected PROGRAM inputs with
`runtime.write-connected-input` and input-mapped variables with
`runtime.write-input-mapped`; forces remain allowed. Unconnected
parameters and connected outputs accept writes. A write runs once at the start of
the next task run while RUN, or immediately while stopped. Multiple pending writes to a variable use the
last value. Pending writes survive STOP until a later scan; an immediate write
to the same variable replaces its pending write. Writes issued after a task's
pending-write stage are queued for the next task run, possibly in the same pass. A force takes priority over a write,
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
EXIT leaves the innermost loop; RETURN leaves the current POU. In a function it
returns to the caller; in the PROGRAM it ends execution for that scan.

The shared scan watchdog allows 200,000 total loop-body iterations, including
nested loops and all function and block calls, and faults on iteration 200,001. It reports
the offending loop span and POU name.
Division by zero reports the expression span; zero FOR step reports the step
expression span. Non-finite values and REAL overflow use `runtime.invalid-value`
at the innermost expression or assignment/FB call that detected the invalid value.
These faults cancel the ticker, clear outputs, latch FAULT and expose a copied
`diagnostic`. Warm restart, cold reset or loading a program clears FAULT.

Unexpected host/library programming errors also clear outputs and latch FAULT,
then propagate to the host; they are not PLC-language diagnostics.

## User functions

Each user call references a shared definition in `ConfigurationIR.functions`. Supplied
input expressions are evaluated left to right in caller storage, then copied into
fresh local storage cloned from a template validated at load. Function bodies and
local initial values are validated once when loading; calls do not walk the body
or repeat those initial-value checks. Omitted inputs, `VAR`,
`VAR_OUTPUT` and the result start at their declared initial values (or defaults)
on every call. Function locals are absent from monitor snapshots, writes and forces.
The same interpreter keeps the scan's loop counter across all calls.

The function's name reads and writes its result variable. RETURN ends only that
invocation. After execution, `=>` outputs copy back in binding order, using implicit
assignment widening; an expression call then yields the result. A no-result function
runs as a statement and produces no inline annotation. Function-statement results
are annotated only in the PROGRAM, as with standard functions; outputs are not
annotated, and function-body statements do not create inline values. Faults inside
a function carry its source POU name and local span, preserved through nested calls.

## User function blocks and temporary storage

Each user FB instance has a persistent frame, aliased to its monitored scalar and
standard FB cells through the compiler's storage mappings. The body is shared by
all instances. Supplied inputs evaluate in caller order before entering the block;
omitted inputs retain their previous values. VAR_INPUT, VAR_OUTPUT and VAR persist
across calls. VAR_TEMP is reinitialized on every block call; PROGRAM VAR_TEMP is
fresh for each scan. Temporaries are absent from snapshots, writes and forces.

After execution or RETURN, `=>` bindings copy outputs in binding order using
assignment widening, including TIME-to-LTIME units. Standard FB calls support the
same output copying. PROGRAM user FB calls annotate all outputs in declaration
order; statements in block bodies produce no inline annotations.

Load and cold reset recreate the entire instance tree and the private state of
nested standard FBs. STOP → RUN, single scan and FAULT preserve persistent state.
Writes and forces use the existing pre/post execution stages on the monitored
VariableIds, including private scalar members. Fault diagnostics carry the
executing `pou` and canonical dotted `instance` path, with the span in that POU.
A function called from a block clears the instance context while its body runs;
faults there name only the function POU. Returning restores the caller's instance
context so later block faults retain their path.

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

TON_TIME, TOF_TIME and TP_TIME are aliases with the same TIME ports and behavior.
TON_LTIME, TOF_LTIME and TP_LTIME use LTIME PT/ET: exact signed 64-bit nanoseconds
represented as decimal strings. Unsuffixed timers still accept only TIME PT.
ET is clamped to PT. TIME ET is truncated to integer milliseconds; LTIME ET is
rounded to the nearest nanosecond from the elapsed fractional milliseconds of
`Clock.now()`. The virtual clock accepts fractional milliseconds, including 1.5 ms
for LT#1500us. The browser host uses `performance.now()`: actual resolution is
browser-dependent and may be coarser due to privacy settings. Floating-point clock
precision also becomes coarser at large timestamps; LTIME storage does not create
precision missing from the clock. Timers use scan-start samples, so Q changes on
the first call at or after the threshold, rather than between scans.

TON/TOF retain ET=PT after completion until reset; TP retains it while IN stays TRUE and resets it to zero once the
pulse is complete and IN=FALSE. Nonpositive PT acts as zero: TON completes
immediately, TOF has no off delay and TP emits no pulse. PT is sampled on every
call while timing; completion stays latched until the corresponding reset, so
increasing PT after completion cannot restart an output. Completed ET follows PT.
Timers read no clock themselves; all elapsed times use the supplied scan start.

R_TRIG/F_TRIG compare CLK with its previous call and emit Q for one call on the
corresponding edge. Both suppress a pulse on their first call, regardless of CLK.

### Bistables, counters and functions

SR is set dominant: `Q1 := S1 OR (NOT R AND Q1)`. RS is reset dominant:
`Q1 := NOT R1 AND (S OR Q1)`. Both start with Q1=FALSE, retain their state
between calls and return to FALSE on cold reset.

CTU increments CV on CU rising edges and sets Q when CV >= PV. R resets CV to
zero. CTD loads PV while LD=TRUE, otherwise decrements on CD rising edges, with
Q when CV <= 0 (including its initial zero state). Counts continue beyond PV/zero
and saturate at the INT limits, 32767/-32768. Reset/load takes priority over an
edge but still samples CU/CD, so releasing it at a held-high level does not count.

CTUD combines CU/CD rising edges, with inputs CU, CD, R, LD, PV and outputs
QU (`CV >= PV`), QD (`CV <= 0`), CV. R resets to zero before LD can load PV;
simultaneous up/down edges cancel. A held-high input does not block a new edge
on the other input. Both histories are sampled even during reset/load.

CTU/CTD/CTUD count in INT. Each also has _INT, _DINT, _LINT, _UDINT and _ULINT
variants with PV/CV in that type. All saturate at the type's lower/upper bounds;
unsigned counters stop at zero when counting down. The 64-bit variants count
exactly with bigint internally and expose canonical decimal strings. They do not
adapt to the type of PV. Cold reset restores CV=0 and clears both edge histories.

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

### Time and date functions

ADD_TIME, SUB_TIME, MUL_TIME and DIV_TIME use the duration operators' implementation,
as do their LTIME forms. ADD_TOD_TIME, ADD_DT_TIME and their SUB and long forms
use calendar arithmetic; SUB_DATE_DATE, SUB_TOD_TOD and SUB_DT_DT return TIME,
and long forms return LTIME. Durations wrap at their declared width, TOD/LTOD wrap
within one day, and out-of-range date/timestamp results fault with
`runtime.invalid-value`. Integer division truncates toward zero; real scaling
computes the exact result and rounds once, nearest with ties to even. For example
DIV_TIME(T#3ms, 2) is T#1ms, but DIV_TIME(T#3ms, 2.0) is T#2ms. Zero divisors fault
with `runtime.division-by-zero` at the call span.

CONCAT_DATE_TOD and CONCAT_DATE_LTOD combine a date with an offset since midnight.
CONCAT_DATE, CONCAT_TOD, CONCAT_LTOD, CONCAT_DT and CONCAT_LDT construct values
from integer components. Components must describe a valid Gregorian date and a
valid time (hours 0–23, minutes/seconds 0–59, milliseconds 0–999). Invalid or
out-of-range results fault with `runtime.invalid-value` at the call span.
DT results floor to seconds; long component constructors retain milliseconds,
while CONCAT_DATE_LTOD preserves all nanoseconds of its LTOD argument.

SPLIT_DATE, SPLIT_TOD, SPLIT_LTOD, SPLIT_DT and SPLIT_LDT return TRUE and emit
INT components through output parameters. Long forms discard sub-millisecond
precision in MILLISECOND. All inputs evaluate once before collecting outputs;
output assignments then run in source order, including aliases. Omitted outputs
are discarded. The interpreter buffers outputs through the optional
`RuntimeLibrary.callFunction` context, which also supplies argument types so integer
and real scaling factors retain their semantics. DAY_OF_WEEK returns 0 for Sunday
through 6 for Saturday. Calendar functions use fixed-epoch UTC operations and
never read the wall clock.

## Snapshots

Snapshots are detached, JSON-serializable copies with images, scalar values, FB
inputs/outputs, the active forced IDs, count,
and execution duration measured by the injected clock. Annotations follow the
[core protocol](core-contracts.md): one entry per executed assignment, function statement or FB call,
using its last execution's values, grouped by POU name and then line, sorted by
column. Only the first instance of each PROGRAM supplies annotations; an
uninstantiated PROGRAM supplies none. Only
PROGRAM statements have annotations. A function statement shows its result;
a function without a result shows nothing. Values
reflect that statement's execution, before any later assignment or force. Each POU
keeps its latest annotations between runs of its first instance, including passes
where only other tasks run. Starting that instance clears only its POU's old entries;
a run with no annotated statements removes them, and a faulting run retains only
completed statements. Load and cold reset clear every POU's annotations. `snapshot()` does not execute the program.

## In-out aliases

Function and function block `VAR_IN_OUT` slots bind directly to the caller's
scalar or aggregate cells on every invocation. Passing an in-out to a nested call
shares the same storage again, including exact 64-bit values and string capacities. Two parameters may share one
actual: a write through either is immediately visible through the other and to
the caller. Ordinary inputs are evaluated left to right and copied before the
body runs, including an input sharing its actual with an in-out. Expression
operands also evaluate left to right, so `Inc(n := x) + x` reads the incremented
`x` in its right operand. Blocks rebind aliases each call, including when the
actual is a fresh temporary; an alias owns no persistent value or VariableId.
Snapshots, writes and forces use only the actual variable's existing ID.

An in-out is an ordinary alias under the existing force stages (ADR 0014).
Forces apply before and after execution, without read-level forcing. With `x`
forced to 10, incrementing it through an in-out and then executing `seen := x`
produces `seen = 11` while the end-of-scan snapshot has `x = 10`.

## Enumeration and subrange storage

Scalar cells retain their declared descriptor alongside the elementary value;
the program's type table resolves named types. Enumeration and subrange variables
still have one monitored `VariableId`. Enumeration snapshots and annotations carry
the base-type integer, and the monitor maps it to the declared member spelling.
The same representation is used for writes and forces. Enumeration integers not
present in the declaration and values outside subrange limits are rejected with
`runtime.debug-value`, leaving the variable and any existing force unchanged.

Every write to a subrange cell checks the limits before mutating storage: ordinary
assignment, function/FB inputs, outputs, result variables and aliased in-outs all
use the cell's own constraint. An invalid dynamic store raises
`runtime.subrange-violation` with `{ value, lower, upper }`, at the active statement
or expression span, preserving POU/instance context. It follows the existing FAULT
and output de-energization rules. Values and limits use decimal strings for 64-bit
bases to preserve precision in diagnostics. Arithmetic itself uses the base type;
only storage applies the range. Cold reset and fresh function/temporary frames
restore declared defaults, including the lower-bound default of a subrange.

## Strings and character storage

Character data uses JavaScript strings inside execution; long numeric values use
`bigint`. Every evaluated literal, variable and function result is converted by
its scalar type before participating in an operation. This keeps STRING `'123'`
distinct from LINT 123 without guessing from its contents. Snapshots, annotations
and Worker commands retain JSON-safe typed values.

String stores keep the first code units up to the destination's capacity, without
faulting. This applies to ordinary assignments, function and FB inputs, outputs,
results, temporaries and in-out aliases. In-outs share the caller's storage, so
the caller's capacity applies even when the formal parameter has another length.
CHAR/WCHAR hold exactly one unit. Single-byte values reject units above 16#FF.
Comparisons order code units lexicographically, including prefix ordering; generic
selection, MIN/MAX/LIMIT and MOVE operate on strings and characters.

Monitor writes and forces validate the complete value before queueing or changing
storage. A wrong scalar type, invalid character representation or value exceeding
capacity is rejected without truncation, changing a prior force or latching a
runtime fault. Cold reset and fresh POU storage restore their declared defaults.

## String functions and conversions

LEN and FIND return INT. LEN counts code units, so a WSTRING surrogate pair has
length two. LEFT/RIGHT take L characters, MID takes L starting at 1-based P,
DELETE removes L starting at P, and REPLACE replaces that range with IN2. INSERT
inserts after P characters (0 inserts at the front). CONCAT joins two or more
inputs. CHAR/WCHAR inputs implicitly widen to STRING/WSTRING; string-producing
functions return strings, including empty results, even with only character inputs.
FIND returns the first 1-based match, or zero for no match or an empty
needle. String functions preserve STRING/WSTRING and keep the first 1,024 code
units of their result before the destination's storage capacity applies.

Negative L faults with `runtime.invalid-value`. MID/DELETE/REPLACE require
1 ≤ P ≤ LEN(IN), including when L is zero; every position faults on empty input.
INSERT requires 0 ≤ P ≤ LEN(IN1). Lengths reaching past the end are clamped;
full-width integer lengths and positions are checked without precision loss.

Elementary-to-string conversions use `formatValue` without added quotes:
INT -42 becomes '-42', BOOL TRUE becomes 'TRUE', and TIME 1500 becomes 'T#1s500ms'.
String-to-elementary conversions accept surrounding whitespace and the target's
literal body, optionally prefixed with any of its long or short literal prefixes,
case-insensitively. Integers and bit strings accept decimal, binary and hexadecimal
literal forms with digit separators. Parsing checks the target range without
wrapping, with exact decimal rounding for REAL/LREAL and exact 64-bit values.

STRING ↔ WSTRING preserves code units; conversion to single-byte text or CHAR
faults if a code unit is above 16#FF. STRING_TO_CHAR and WSTRING_TO_WCHAR take the
first unit and fault on empty input. CHAR ↔ WCHAR preserves the unit, and
CHAR ↔ BYTE / WCHAR ↔ WORD converts between the unit and its numeric code.
Overloaded TO_ forms use the same operations. Invalid syntax, a wrong prefix,
out-of-range values and invalid character narrowing fault with
`runtime.invalid-value` at the function call span, preserving POU/instance context.

## Arrays

Persistent array leaves share monitored scalar cells through recursive array
storage. Index expressions evaluate left to right; every dimension is checked
before selecting storage. An out-of-bounds index faults with
`runtime.index-out-of-range` and `{ index, lower, upper }`, plus POU and instance
path. Multidimensional arrays use row-major offsets; nested arrays use chained
indices. Indexed elements support scalar assignment and bit access.

Whole-array assignment and selection copy values before storing them, including
self/overlapping copies. Stores apply each destination leaf's subrange check and
string capacity. PROGRAM/FB temporaries reset per scan/call and function local
arrays reset on each invocation. Cold reset restores initial values; STOP/RUN
preserves persistent leaves.

The runtime's `watch(ids)` selects array leaves for snapshots. Ordinary leaves
and forced array leaves are always included. Compact snapshots carry parallel
`variableIds` and `variables`; use `snapshotVariable` to look up a leaf. Whole-array
stores do not produce inline annotations; scalar element stores do.

## Structures

Structures use ordered aggregate cells and the same scalar leaf storage as arrays.
`structureMember` selects a member by its declaration index; member and array
locations compose recursively. Whole-structure assignment and MOVE/SEL/MUX read
independent values before copying each destination leaf, so modifying a copy
never aliases its source. Scalar stores retain each destination's subrange checks
and string capacity. A default can include recursively nested arrays and structures.

PROGRAM/FB VAR members persist across scans and STOP/RUN; function locals,
PROGRAM VAR_TEMP and FB VAR_TEMP receive fresh defaults at their normal invocation
boundaries. Cold reset restores declared defaults. Monitoring watches and forces
scalar member IDs under paths such as `LINE[2].START.X`; ordinary leaves and forced
members are always sent, and watched members use the compact snapshot ID mapping.

## Function block arrays

An instance array uses aggregate storage containing independent standard block
cells or user instance frames, with shared code definitions. Indexed calls resolve
and bounds-check the instance once before evaluating inputs. An invalid index
faults with `runtime.index-out-of-range`, the calling POU and the indexed instance
path (for example `T[5]`). Faults inside user elements retain the full nested path,
such as `M[2].DELAY`.

Load and cold reset initialize every element's complete instance tree, including
nested timer/counter private state. STOP/RUN transitions, single scans and FAULT
preserve it. Monitored scalar leaves and standard block snapshots alias the same
cells used by execution, so writes and the existing pre/post-scan force stages
apply to element members by VariableId.

## Aggregate parameters and bounds

Function and user block inputs copy array and structure values recursively before
execution; omitted function inputs use their declared initial value, while omitted
block inputs retain their value. Function outputs/results reset on every invocation;
block outputs persist. `=>` and aggregate function results copy whole values,
applying each target leaf's string capacity and subrange check. Public aggregate
block inputs and outputs can be read as whole values; inputs can be assigned.
Whole aggregate results and ports do not create scalar inline annotations.

An aggregate cell carries its concrete type descriptor as well as its children.
An open-array in-out binds to that cell, preserving the actual bounds even when
forwarded to another open-array parameter. The `arrayBound` expression reads a
checked, zero-based dimension and returns its lower or upper bound as DINT.
Detached aggregate values retain their concrete descriptor. A whole copy between
open in-outs checks actual bounds and element types before writing; incompatible
actuals fault with `runtime.invalid-value`, including through MOVE/SEL/MUX.
Index references calculate row-major offsets from the actual cell's dimensions;
an index outside them faults with `runtime.index-out-of-range` in the executing POU.

Element and member in-out actuals resolve to existing child cells. Argument values
and alias locations are evaluated together in source order, with each index
evaluated once before entering the callee. Aliases add no monitoring identities.
A forced element follows the ordinary before/after scan force stages through an
alias, so a write is visible during execution and the force is restored afterward.

## References

Reference cells contain `NULL` or a location in persistent storage. Assignment,
aggregate copying and POU parameter/result passing copy that location, preserving
the referenced cell. Postfix dereference resolves it before further member or
index access. Writes through it apply the target's normal coercion, string
capacity and subrange checks. Forces apply at the existing scan stages to the
target's own monitored variable. Equality compares storage identity.

Dereferencing `NULL` raises `runtime.null-reference` with the executing POU,
source span and, inside a block, instance path. Load and cold reset restore every
reference to `NULL`. Stop/run retains references. Snapshots and inline annotations
serialize only `{ kind: "reference", target: string | null }`, using the target's
display path. References reject monitor writes and forces; target values remain
monitored at their own paths.

## Global storage

Each non-constant configuration/resource global has one storage tree, shared by
all importing program and function block instances. External frame slots reference
the same scalar cells, aggregates or FB instance; there is no per-instance copy.
Load and cold reset initialize configuration globals first, then resource globals,
each in declaration order, before program instance storage. Global constants have
no VariableId and appear in neither snapshots nor the monitor.

Global snapshot paths are their own names (and flattened element/member paths),
without a program-instance prefix. Writes and forces use the global leaf's VariableId.
Programs within a task execute in resource declaration order, so later programs
see earlier writes in the same task run. Forces are restored around each program instance, including
before a later instance reads a forced global. Located globals use the same input
refresh, output publication and STOP safety rules as located PROGRAM variables.

## Byte-backed direct areas

Located variables are live views of shared I/Q/M bytes, including accesses through
references, external bindings and VAR_IN_OUT parameters. I/Q have 64 bytes each;
M has 1,024. Numbering counts units, and all multi-byte values use little-endian
order. Thus writing `%MW0 := 16#0102` makes `%MB0` equal 2 and `%MB1` equal 1;
`%MX1.0` reads bit 8 of the same word. REAL/LREAL use IEEE binary32/binary64.

Each task refreshes all I bytes from the host image and publishes all Q bytes.
Located I variables reject one-shot monitor writes and accept forces. Typed
connections decode using the parameter's type. Outputs are zero throughout the
whole Q area outside RUN and during emergency stop, including connections without
a located declaration. A STOP single scan also finishes with zero outputs.

Load and cold reset zero M and apply explicit located initializers in order:
configuration globals, resource globals, then each program instance in declaration
order. An uninitialized overlapping view does not erase an earlier initializer.
Warm restart also zeroes M and reapplies these initializers; see
[Retentive storage and warm restart](#retentive-storage-and-warm-restart).

Writing an overlapping integer view can store any IEEE bit pattern without a
fault. A program read of a REAL/LREAL NaN or infinity, including an input connection
copy, faults with `runtime.invalid-value` at the read expression or configuration
connection. Snapshots report `invalidReal` with the raw bits and never decode it
into a non-finite number. A finite write or an applied force replaces those bytes.

## Retentive storage and warm restart

`warmRestart()` is accepted in every state. It stops execution, initializes all
non-retained storage and the I/Q/M areas, clears faults, forces, pending writes,
annotations, event samples and task telemetry, and sets the operating state to
STOP. An active emergency-stop overlay remains active until released. In FAULT
this is the acknowledge-fault command; RUN and single scan cannot leave FAULT.
Load and cold reset initialize retained storage too.

RETAIN and NON_RETAIN qualify PROGRAM/FUNCTION_BLOCK VAR, VAR_INPUT and VAR_OUTPUT,
and configuration/resource VAR_GLOBAL. Unqualified declarations default to
NON_RETAIN. A qualified composite or user block passes its qualifier to members
without their own qualifier; explicit member qualifiers override inheritance.
References always become NULL and timers always reinitialize, even under RETAIN.
Retained counters, edge detectors and bistables preserve every port and private
edge history, including an edge detector's first-call state.

`retentiveRecords()` returns one complete detached JSON-safe set: scalar leaf
records plus standard-block records containing ports and private state together.
`restoreRetentive(records)` initializes storage, then matches case-insensitive
paths and data types; standard blocks require their exact variant (CTU differs
from CTD and CTU_DINT). String capacity may shrink and values truncate on store.
Missing, obsolete, corrupt or mismatched records keep initial values and return
their paths without faulting. A block is validated as a whole before its ports
are restored; no CV or port can leak across a changed block type. Scalar members
of retained user blocks have their own leaf records; standard-block ports never
have separate leaf records.

## Method invocation

A method resolves its receiver before evaluating arguments, shares its instance's
persistent cells and appends fresh cells for parameters, locals and its result.
In-out arguments alias caller cells and outputs copy back after execution, as for
functions. `RETURN` ends only the current method. Method loops count against the
same scan watchdog budget as their callers. Faults retain the original source span,
name the method as `Counter.Increment` and include the receiver path when known.
Nested method calls restore the caller's instance context on return. Method locals
are absent from snapshots and cannot be written or forced through the protocol.

## Class instances

Class instances use user-block storage and method invocation, including nested
blocks/classes and arrays of instances. The definition's `kind: "class"` marks an
empty body; compiled code invokes only its methods. Each instance's definition
index records its actual type. Load and cold reset initialize all class members.
Warm restart and reload follow ADR 0016: instance qualifiers pass to unqualified
members, while explicit RETAIN/NON_RETAIN members override them. Scalar retained
members restore by dotted path and type just as block members do.

Every scalar non-CONSTANT member appears in snapshots and supports writes and
forces, including PRIVATE and PROTECTED members. Constants and method locals have
no monitored IDs. Faults inside class methods carry `Type.Method`, the class source
span and the receiver path, with the caller's shared watchdog budget.

## Inherited execution

Instances retain their actual definition index. Methods use its effective method
table for dynamic binding, including calls made by a base method through THIS or an
unqualified method name. SUPER calls select the base implementation statically
while preserving that actual receiver for subsequent virtual calls.

Inherited members occupy a base-first prefix of instance storage. An inherited
method shares only its declaring receiver prefix before appending fresh locals;
dispatched parameter slots map by signature order within each parameter section
to the chosen implementation. Locals may appear before or between parameters.
This prevents method locals from overwriting additional derived members. Inputs,
outputs, in-out aliases and results retain the usual method semantics.

Empty derived block bodies run the effective base body. SUPER() runs that same body
on current instance storage and inputs; RETURN leaves only that invocation. Faults
in inherited methods and bodies name the declaring type's text and the actual
instance path. Inherited members initialize on load/cold reset and follow ADR 0016
qualifier inheritance during warm restart and retained reload.

## Interface dispatch

Interface variables use reference cells whose targets are instance storage. Calls
resolve the receiver before arguments, fault with runtime.null-reference on NULL,
then select the actual type's method by prototype name. Parameter positions map
from the prototype layout to the concrete method layout, including inherited
methods and overrides. Faults identify the declaring method's source and target
instance path. THIS binding preserves that same instance identity.

An interface assignment attempt checks the actual type's implemented-interface
list; mismatch and NULL both store NULL without a fault. Interface cells start
NULL on load, cold reset, warm restart and reload, even under RETAIN. STOP/RUN,
single scans and FAULT preserve targets. Snapshots expose the instance path or
NULL using the existing reference value shape; writes and forces are rejected.

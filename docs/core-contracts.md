# Core contracts

`@benchtop-plc/core` exports elementary values, tree IR, source positions and the
UI/runtime wire protocol. It has no host APIs or dependencies. The compiler checks
semantic validity before producing IR; these TypeScript contracts are not an
untrusted-input validator.

## Values

`BOOL` uses `boolean`; SINT, USINT, INT, UINT, DINT, UDINT, BYTE, WORD, DWORD,
REAL, LREAL, TIME, DATE, TOD and DT use `number`. LINT, ULINT, LWORD, LTIME,
LDATE, LTOD and LDT use canonical decimal
`string`s in typed values, IR and protocol messages. Canonical means an optional
minus, decimal digits without leading zeros, no plus, whitespace or negative zero,
and a value in range. LINT/LTIME/LDATE/LTOD/LDT use signed 64-bit storage; ULINT/LWORD are unsigned 64-bit.
`parseLong(type, text)` validates this representation and returns `bigint`;
`coerceLong(type, value)` wraps integer/duration results to 64 bits and returns a canonical string.
For calendar types it checks dates or wraps times of day within one day.
`isLongType` identifies these types. `ScalarValue` additionally admits `bigint` for
internal computation; `TypedValue` never contains a bigint.
TIME ranges from `T#-24d20h31m23s648ms` to `T#24d20h31m23s647ms`.
`TypedValue` pairs a `dataType` discriminator with a matching `value`.
`coerceValue(type, value)` dispatches by type:

| Type         | Coercion                                                     |
| ------------ | ------------------------------------------------------------ |
| BOOL         | Zero becomes FALSE; any other finite number becomes TRUE     |
| SINT         | Truncate toward zero, wrap to signed 8 bits                  |
| USINT, BYTE  | Truncate toward zero, wrap to unsigned 8 bits                |
| UDINT, DWORD | Truncate toward zero, wrap to unsigned 32 bits (`>>> 0`)     |
| WORD         | Truncate toward zero, wrap to unsigned 16 bits               |
| INT          | Truncate toward zero, wrap to signed 16 bits                 |
| UINT         | Truncate toward zero, wrap to unsigned 16 bits               |
| DINT         | Truncate toward zero, wrap to signed 32 bits                 |
| REAL         | Round with `Math.fround` to IEEE 754 binary32                |
| LREAL        | Preserve JavaScript binary64 precision                       |
| LINT, LTIME  | Wrap to signed 64 bits; return canonical decimal string      |
| ULINT, LWORD | Wrap to unsigned 64 bits; return canonical decimal string    |
| TIME         | Truncate toward zero to milliseconds, wrap to signed 32 bits |

Helpers accept boolean, numeric, decimal-string or bigint values (TRUE converts to 1, FALSE to 0).
They are representation helpers, not the compiler's implicit-conversion rules.
NaN, infinity and REAL overflow raise `RangeError`; negative zero is normalized
to zero so that valid values survive JSON transport. The compiler/runtime must
translate invalid computations into diagnostics at their source spans.

TIME arithmetic results wrap modulo 2^32. TIME * or / REAL/LREAL computes the
exact product or quotient of the represented operands and rounds once to whole
milliseconds, nearest with ties to even, before wrapping; TIME / integer truncates
toward zero. `timeBinary` shares this calculation between compiler and runtime.
TIME literals are checked against the range by exact value before fractional
milliseconds are truncated; out-of-range literals are `type.invalid-constant`.
Typed constant operations follow runtime arithmetic. IR initial values and
write/force values must satisfy their declared type's range and representation.
`validateValue` rejects out-of-range or fractional integers, non-finite reals, REAL
values not representable as binary32, negative zero and incorrectly represented BOOLs
without coercion. `validateTime` remains available for TIME-only validation.
The project codec checks scalar initializer ranges on import and export. All TIME and LTIME timers treat negative PT as zero.

`formatValue(type, value)` uses IEC syntax independent of UI locale: TRUE/FALSE,
decimal integers, full-width uppercase hexadecimal bit strings (`16#00FF` for WORD),
a decimal point for REAL/LREAL (also in an exponent's mantissa),
and TIME as `T#1s500ms`. `formatTime` emits d/h/m/s/ms in descending order, omits
zero components, uses `T#0ms` for zero, and places a minus sign after `T#` for
negative durations. Formatting coerces the value to its declared type first.
LTIME formats as `LTIME#1d2h3m4s5ms6us7ns`, omitting zero components; zero is
`LTIME#0s`. LWORD uses 16 hexadecimal digits. `ltimeBinary` computes exact nanosecond
arithmetic, including real scaling with one nearest-even rounding. TIME/LTIME
conversion truncates toward zero when reducing resolution, then wraps.
REAL uses the fewest significant decimal digits (at most nine) that round back to
the same binary32 value, so `0.1` displays as `0.1` rather than
`0.10000000149011612`. LREAL retains JavaScript's shortest binary64 representation.

## Calendar values

DATE and DT store unsigned 32-bit seconds since the Unix epoch; DATE must be a
whole multiple of 86,400 seconds. TOD stores milliseconds since midnight in
0–86,399,999. LDATE, LTOD and LDT store canonical signed 64-bit nanoseconds;
LDATE must be a whole multiple of 86,400 × 10^9, and LTOD is nonnegative and less
than one day. All six default to storage zero (1970-01-01 or midnight).
Ranges are listed in [compliance.md](compliance.md).

`validateValue` and `parseLong` enforce these invariants on external values, including
IR literals and initial values, writes and forces. The project codec validates
calendar initializers with the compiler. `coerceValue` rejects dates outside their
range and wraps TOD/LTOD computations modulo one day. `formatValue` uses `D#`,
`TOD#`, `DT#`, `LDATE#`, `LTOD#` and `LDT#`, omitting trailing fractional zeros.
TOD has millisecond precision, DT whole seconds, and long forms up to nine
fractional digits. Values have no time zone; fixed-epoch UTC calendar operations
never read the wall clock.

`parseCalendar`, `calendarBinary` and `convertCalendar` share exact nanosecond
calculations between compiler and runtime. Differences produce TIME/LTIME and wrap
to the duration's width. DT ± TIME floors the exact result to seconds; calendar
conversions floor to the coarser destination unit before checking its range.
Calendar arithmetic nodes retain operand types to identify units, including mixed
short/long operands. Implicit assignment and selection widening uses conversion nodes.

## Tree IR

All nodes, including declarations, branch arms, labels and named FB inputs, carry
a `SourceSpan`. Positions are one-based; the end is exclusive. A program has one
variable table in declaration order and a statement tree. Each variable retains
its source spelling and upper-case key. Scalar declarations contain their coerced
`initialValue`, including defaults. FB declarations use `initialValue: null` to
request the standard FB's initial state; user initializers on FBs are unsupported.
Only BOOL declarations may have a direct bit address; milestone 1 uses byte 0,
bits 0–7 in areas I and Q.

Bit references (`kind: "bit"`) contain a scalar variable index, a checked bit index
and `dataType: "BOOL"`. Reads test that bit; writes preserve all other bits, including
DWORD's unsigned representation. LWORD bit access extends through bit 63 and uses bigint masks. Integer multiplication keeps the low width bits
with `Math.imul`, avoiding binary64 precision loss for 32-bit products. Long operations use bigint.
CASE labels carry numbers for short integers and canonical strings for long integers.
Implicit widening to a long operand is represented with conversion-call nodes,
including the unit change from TIME milliseconds to LTIME nanoseconds.

Variable references, assignment targets, FOR variables and FB calls use zero-based
indices into `ProgramIR.variables`. FB member references use an input/output
discriminator and an index into the corresponding descriptor array. Named FB
arguments retain the canonical name for inspection and the resolved input index
for execution. Standard-function names are closed opcodes, not unresolved source
identifiers. Expressions explicitly carry their result type; `&` lowers to AND.
Function calls may carry `outputs`, each with a resolved descriptor output index,
a writable assignment target and a source span. A `kind: "call"` statement wraps
a function-call expression and discards its result. Input expressions precede all
output assignments; output bindings retain source order, including aliases.
The compiler checks operand types, index validity, writable inputs, integer CASE
labels/ranges, integer FOR bounds/step and BOOL conditions. An omitted FOR step
lowers to a literal 1. ELSIF is represented by subsequent conditional branches.

Port indices follow core's shared `standardFunctionBlocks` registry. The compiler
and runtime consume these descriptors, with implementations in runtime:

| FB                                        | Inputs, in index order                           | Outputs, in index order                          |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| TON, TOF, TP; TON_TIME, TOF_TIME, TP_TIME | IN: BOOL, PT: TIME                               | Q: BOOL, ET: TIME                                |
| TON_LTIME, TOF_LTIME, TP_LTIME            | IN: BOOL, PT: LTIME                              | Q: BOOL, ET: LTIME                               |
| R_TRIG, F_TRIG                            | CLK: BOOL                                        | Q: BOOL                                          |
| SR                                        | S1: BOOL, R: BOOL                                | Q1: BOOL                                         |
| RS                                        | S: BOOL, R1: BOOL                                | Q1: BOOL                                         |
| CTU, CTU_INT                              | CU: BOOL, R: BOOL, PV: INT                       | Q: BOOL, CV: INT                                 |
| CTD, CTD_INT                              | CD: BOOL, LD: BOOL, PV: INT                      | Q: BOOL, CV: INT                                 |
| CTUD, CTUD_INT                            | CU: BOOL, CD: BOOL, R: BOOL, LD: BOOL, PV: INT   | QU: BOOL, QD: BOOL, CV: INT                      |
| CTU_T, CTD_T, CTUD_T                      | Same order as the corresponding INT block, PV: T | Same order as the corresponding INT block, CV: T |

In the last row, T is DINT, LINT, UDINT or ULINT. The registry contains each
concrete name (for example CTUD_ULINT); it has no type-adapting overloads.

IR contains only finite primitive values, arrays and plain objects. Optional
fields are omitted, never explicitly set to undefined; no Maps, Sets, functions
or class instances are stored in it. The hand-written fixture at
`tests/conformance/fixtures/reference-ir.ts` represents the parent issue's exact
`reference.st` program. Its tests verify transport, source positions and resolved
reference types. This does not execute the program; compilation and execution
are covered by later milestone issues.

## Protocol

`UiToRuntimeMessage` and `RuntimeToUiMessage` are discriminated by `type`. A variable
ID always refers to the currently loaded program. `force` takes a typed value or
null to clear the force; `write` takes a typed value. Hosts validate that the
value matches the loaded declaration. `setCycle.ms` is a positive finite interval.
`setInput.bit` indexes the eight-bit input image. `step` requests one complete scan.
Emergency-stop state and single-scan behavior are implemented in the runtime
issues, not in the transport types.

Snapshots contain scan count, last execution time in milliseconds, eight-bit input
and output tuples, values aligned with the variable table (including FB input and
output arrays in descriptor order), forced variable IDs, and annotations keyed by
one-based source line. Each annotation contains the full `span` of its assignment
or FB call, so consumers identify statements by source location rather than array
position. Entries are grouped by `span.line` and sorted by `span.column` on each
line. Only statements executed in the current scan are included; unexecuted
statements have no placeholder, empty lines are omitted, and prior-scan values
are not retained.

A snapshot is delivered after the scan, with one annotation per executed
assignment or FB call. Its `values` are captured at that statement's last execution
in the scan: a single assignment result, or the FB's outputs in descriptor order
(for TON, `[Q, ET]`). Repeated execution in a loop replaces that statement's
previous values; it does not append executions or flatten FB output arrays.
Arrays preserve JSON transport instead of using Set or Map.

Fault events carry a `Diagnostic` discriminated by its stable `code`, with a
code-specific `args` object, severity and optional source span. The codes and
argument conventions are documented in [diagnostics.md](diagnostics.md). Localized
message text belongs to the UI catalog.

Expected validation failures for `force` and `write` produce a non-fatal `rejected`
event with `command: "force" | "write"` and a `Diagnostic<CommandRejectionCode>`.
The rejection codes identify invalid scalar targets, mismatched types, invalid
values and writes to input-mapped variables. Rejections preserve operating state,
memory, forces, pending writes and the Worker connection. They are separate from
PLC `fault` events and never replace a latched fault's diagnostic. The host also
publishes its current state and snapshot after a rejection. `step` outside STOP
remains ignored as specified in #10.

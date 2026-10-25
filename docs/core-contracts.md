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

## Type descriptors and scalar derived types

`TypeDescriptor` describes a declared or expression type. Elementary descriptors
are the existing `DataType` strings. `{ kind: "named", name: "State" }` refers to
an entry of the optional, ordered `ConfigurationIR.types` table. An inline subrange is
`{ kind: "subrange", base: "INT", lower: 0, upper: 100 }`; it has no table entry.
Bounded strings use `{ kind: "string", base: "STRING" | "WSTRING", length }`;
characters use `{ kind: "character", base: "CHAR" | "WCHAR" }`. Arrays use
`{ kind: "array", dimensions: [{ lower, upper }], element }`; references use
`{ kind: "reference", target }`. Type table entries contain `name`, `definition` and an `initialValue`,
which can be a scalar or recursively nested ordered aggregate list.
Definitions are enumerations (integer base and ordered named values), subranges,
aliases (target descriptor), and structures. A structure definition is
`{ kind: "structure", members: [{ name, dataType, initialValue }] }`; its
`initialValue` is a list in member order. Descriptors distinguish that list from
an array initializer. Structure names use name equivalence, including through aliases.

IR expression and scalar variable `dataType` fields carry descriptors. Elementary
literal/value correlations remain discriminated unions. Derived literal and
initializer values use the underlying scalar representation. Diagnostic type
arguments carry descriptors too; `formatType` prints source-like text without
localization (`State`, `INT (0..100)`). `scalarBase` resolves the leaf type through
the table; `sameScalarType` unwraps aliases, compares enumerations by identity and
subranges by base and limits. `validateDeclaredValue` checks storage constraints
before coercion; `validateScalar` additionally checks the elementary representation.

`DataType` and `TypedValue` remain elementary scalar contracts. Enumeration and
subrange snapshots, annotations, writes and forces use the integer base type,
including decimal strings for 64-bit bases. Each persistent variable keeps one
`VariableId`. The UI uses its descriptor and the type table to show an enumeration
name and resolve case-insensitive names for writes and forces. Inline enum values
use the assignment target descriptor. Invalid monitor integers are rejected without
changing storage or latching a PLC fault (ADR 0015).

## Tree IR

All nodes, including declarations, branch arms, labels and named FB inputs, carry
a `SourceSpan`. Positions are one-based; the end is exclusive. A program has one
monitored variable table and a statement tree. Persistent declarations expand in source order; user block instances expand depth first into dotted scalar and standard FB entries. Each variable retains
its source spelling and upper-case key. Scalar declarations contain their coerced
`initialValue`, including defaults. FB declarations use `initialValue: null` to
request the standard FB's initial state; user initializers on FBs are unsupported.
Located scalars carry a `DirectAddress`: `{ area, size: "X", byte, bit }` for bits,
or `{ area, size: "B" | "W" | "D" | "L", index }` for unit-numbered values.
Areas I/Q have 64 bytes each and M has 1,024. The compiler checks size/type bindings
and bounds; aliases of the bound elementary types are allowed. `addressInitializer`
marks an explicit initializer to apply after zeroing M, in declaration order.

Bit references (`kind: "bit"`) contain a scalar variable index, a checked bit index
and `dataType: "BOOL"`. Reads test that bit; writes preserve all other bits, including
DWORD's unsigned representation. LWORD bit access extends through bit 63 and uses bigint masks. Integer multiplication keeps the low width bits
with `Math.imul`, avoiding binary64 precision loss for 32-bit products. Long operations use bigint.
CASE labels carry numbers for short integers and canonical strings for long integers.
Implicit widening to a long operand is represented with conversion-call nodes,
including the unit change from TIME milliseconds to LTIME nanoseconds.

Variable references, assignment targets, FOR variables and FB calls use zero-based
`FrameSlot` indices into the executing frame (the monitored table for legacy single-program IR). FB member references use an input/output
discriminator and an index into the corresponding descriptor array. Named FB
arguments retain the canonical name for inspection and the resolved input index
for execution. Standard-function names are closed opcodes, not unresolved source
identifiers. Expressions explicitly carry their result type; `&` lowers to AND.
Function calls may carry `outputs`, each with a resolved descriptor output index,
a writable assignment target and a source span. A `kind: "call"` statement wraps
a standard or user function call and records its result for inline display when
called in the PROGRAM. A no-result user call produces no annotation. Input expressions precede all
output assignments; output bindings retain source order, including aliases.
The compiler checks operand types, index validity, writable inputs, integer CASE
labels/ranges, integer FOR bounds/step and BOOL conditions. An omitted FOR step
lowers to a literal 1. ELSIF is represented by subsequent conditional branches.

`ConfigurationIR.functions`, when present, stores shared user function bodies with local
scalar variables, input/output indices, optional in-out slots and an optional result-variable index.
`userFunctionCall.function` indexes this table; its input/output `variable` fields
index the callee's local table, while argument expressions and output targets use
the caller's table. `dataType: null` denotes a no-result statement call; expressions
always have an elementary type. Function locals are fresh per call and never appear
in snapshots. Standard formal calls may carry an `evaluationOrder` permutation of
`args` indices so source order is preserved independently of descriptor order.

`ConfigurationIR.functionBlocks` holds shared `UserFunctionBlockIR` bodies with local
`variables` (scalar, array, structure, standard FB or user FB declaration), input/output slot arrays
and temporary slots, plus optional in-out slots. `userFbCall` and `userFbMember` reference a caller frame slot;
member/input/output indices are slots in the callee definition. Standard `fbCall`
now also accepts `outputs` with descriptor output indices and writable targets.

Each `resource.programs[i].storage` maps each declaration slot to a monitored
`VariableId` (an index into monitored storage/snapshots), a temporary scalar initializer, or an `instances` index. Each
`UserFunctionBlockStorage` contains the block index, canonical `path`, and its own
storage mapping. An in-out slot uses `{ kind: "inOut" }` without a VariableId.
All persistent scalar leaves and standard FBs live in
`ConfigurationIR.variables`; user instance objects and temporaries do not appear in
snapshots. Frames alias those monitored cells, so writes and forces address the
same state the shared body executes against. The runtime also accepts the earlier
standalone `ProgramIR` form for hand-authored low-level fixtures. Load/cold reset rebuilds all
persistent cells, including nested standard FB private state.

User function and block calls may carry `inOuts: InOutBinding[]`. Each binding's
`variable` indexes the callee's slot; `actual` is a scalar `VariableReference` in
the caller's frame. Calls bind those slots to the actual cells after evaluating
ordinary inputs, and aliases introduce neither copied values nor monitor IDs.

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
value matches the loaded declaration. `setCycle.ms` is a positive finite interval, rejected with
`runtime.configured-cycle` when the loaded configuration is explicit.
`setInput` carries an input address string and a `TypedValue`, for example
`{ type: "setInput", address: "%IW0", value: { dataType: "INT", value: -5 } }`.
The host validates the address, binding and value before storing its bit pattern.
`step` requests one complete scheduler pass.
Emergency-stop state and single-scan behavior are implemented in the runtime
issues, not in the transport types.

Snapshots contain scan count, last execution time in milliseconds, 64-byte input
and output arrays (values 0–255), values aligned with the variable table (including FB input and
output arrays in descriptor order), forced variable IDs, and annotations keyed by
POU name and then one-based source line. Each annotation contains the full `span` of its assignment,
function statement or FB call, so consumers identify statements by source location
rather than array position. Entries are grouped by `span.line` and sorted by `span.column` on each
line. Each POU retains the annotations from its first instance's latest run across
passes where that instance does not run. Starting that instance clears its POU's
previous entries, so skipped statements do not retain old values and a faulting run
contains only completed statements. Empty POUs/lines are omitted. Load and cold
reset clear all entries.

Only PROGRAM statements are annotated. A function without a result has no
annotation, and function outputs are not included. A snapshot is delivered after
the scan, with one annotation per executed
assignment, function statement or FB call. Its `values` are captured at that
statement's last execution in that instance run: a single assignment or function-statement
result, or the FB's outputs in descriptor order (for TON, `[Q, ET]`). Repeated
execution in a loop replaces that statement's
previous values; it does not append executions or flatten FB output arrays.
Arrays preserve JSON transport instead of using Set or Map.

Fault events carry a `Diagnostic` discriminated by its stable `code`, with a
code-specific `args` object, severity, optional source POU name (`pou`) and span. The codes and
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

## Character values

`DataType` and `TypedValue` include STRING, WSTRING, CHAR and WCHAR, all encoded
as JavaScript strings. Their discriminator distinguishes text from canonical
64-bit decimal strings: `{ dataType: "STRING", value: "123" }` and
`{ dataType: "LINT", value: "123" }` retain different types in JSON, snapshots,
annotations and write/force commands. Runtime computations use `bigint` for long
numbers and `string` for text; `internalValue(type, value)` performs that boundary
conversion before the shared operators run.

A STRING or CHAR code unit is 0–255 (ISO/IEC 8859-1); WSTRING and WCHAR preserve
UTF-16 code units, including isolated surrogates. A character holds exactly one
code unit. A string's descriptor supplies its capacity (default 80, allowed
1–1,024); a `TypedValue` carries no length. `sameScalarType` ignores capacities,
including through aliases. `validateScalar` rejects external values exceeding
storage capacity, and `truncateString` applies capacity to runtime stores.
`coerceValue` validates text representation without interpreting numeric-looking
text. `formatValue` emits quoted ST literals, escaping dollars, delimiters,
controls and surrogate units; `readStringLiteral` decodes the same syntax.

## Array storage and snapshots

Array expressions carry descriptors. `index` references hold their array reference
and integer index expressions; `elementBit` addresses a bit of an indexed leaf.
`ArrayVariable` describes function locals and temporaries. Persistent arrays expand
into consecutive scalar variables with display names (`M1.A[2,1]`, `N[1][3]`) and
`path` segments. `composites` records each collapsible array and its descriptor.
Recursive `array` storage slots group the leaves without copying shared POU bodies.

`watch` supplies a set of leaf IDs. For a program containing arrays, snapshots use
parallel `variableIds` and `variables` arrays: ordinary variables, watched array
leaves and forced leaves only. `snapshotVariable(snapshot, id)` handles both this
compact form and the original scalar-only layout. The monitor indexes each
snapshot once for constant-time row lookups. Writes and forces still use
leaf IDs. Whole-array assignments have no inline scalar annotation.

## Structure storage and snapshots

`StructureVariable` holds local/temporary structure descriptors and ordered initial
values. Persistent members expand to scalar `variables` with stable IDs and paths
such as `["LINE", "[2]", "START", "X"]` (`LINE[2].START.X`). Every structure
and array has a `composites` entry; recursive `structure`/`array` storage slots
share their scalar cells with monitoring. `structureMember` IR references retain
an object reference and a member index. Their object and an `index` reference's
array can themselves be member or index references, allowing arbitrary chains.
`elementBit` can select a bit of an indexed element or structure member.

Snapshots, watches, writes and forces use scalar leaf IDs, with no aggregate
payload. Whole-structure copies and selection have no scalar inline annotation.

## Reference values and storage

`{ kind: "reference", target: TypeDescriptor }` describes `REF_TO T`.
`ReferenceVariable` has `kind: "reference"`, its declared descriptor, and
`initialValue: null`; aggregate initial-value lists can contain `null` leaves.
The IR uses `referenceOf` with a storage target, `null`, and `dereference` with a
reference expression. Dereferences are storage references and assignment targets,
so member and index nodes can continue the access chain. Reference targets never
contain runtime objects in IR.

`VariableSnapshot` and `StatementAnnotation.values` carry a reference as
`{ kind: "reference", target: string | null }`. The target is the referenced
storage's display path, such as `P1`, `POINTS[2]` or `M1.SPEED`, or `null` for
`NULL`. `TypedValue` continues to describe elementary values. Reference variables
cannot be written or forced; dereferenced values retain their target's identity.

## Configuration and resource IR

`ConfigurationIR` is the compiler result (`kind: "configuration"`, configuration
`name`, source `span`, and `explicit`). It contains:

- `programs`: shared PROGRAM names, spans and statement bodies, once per POU;
- `resource`: its name, `tasks` in declaration order and
  `programs` in declaration order (`name`, zero-based `program` and `task` indexes,
  and per-instance `storage`);
- `variables`: one flat monitored table across every program instance;
- optional `types`, `functions`, `functionBlocks`, nested block `instances` and
  aggregate `composites`.

Every monitored variable has an instance-qualified `name`, uppercase `key`, path
segments and owning `instance`, for example `A.n` / `A.N` / `["A", "n"]`.
Only array descendants have `watched: true`; adding an instance path never makes
an ordinary scalar disappear from snapshots. Writes and forces still address a
unique `VariableId`. References publish the qualified target path.

Annotations have shape `Record<POUName, Record<Line, StatementAnnotation[]>>`.
Each PROGRAM uses its first instance in resource declaration order. Uninstantiated
PROGRAMs have no entries; an earlier instance's values cannot be overwritten by
another instance of the same body. Runtime faults carry `task` and a qualified
`instance` path as well as the executing `pou`.

## Task IR and telemetry

`TaskIR` is a cyclic task (`name`, `intervalMs`, `priority`) or event task
(`name`, `priority`, `single`). `single` is JSON data: either
`{ kind: "variable", variable: VariableId }` bound to a non-constant BOOL global,
or `{ kind: "address", address: DirectAddress }` for a supported input bit.
An instance's zero-based `task` index selects its task independently of its
resource declaration position. The implicit configuration remains one cyclic task.

Every `RuntimeSnapshot` includes `tasks: TaskTelemetry[]` in declaration order,
empty before load. Each entry contains `name`, `runCount`, `lastExecutionTimeMs`,
`maxExecutionTimeMs` and `overruns`. All numbers are JSON-safe; timing uses the
injected Clock. Snapshots copy entries so clients cannot mutate scheduler state.
Load/cold reset clear the values; STOP/RUN preserve them. `scanCount` counts passes
with at least one attempted task run, including a faulting run. The Worker host
forwards these fields in ordinary snapshot messages. Runtime faults name the task
that failed and prevent every later task in that pass from running.

A located REAL/LREAL whose bytes encode NaN or infinity is represented in snapshots
as `{ kind: "invalidReal", bits: "16#7FC00000" }` (8 or 16 hex digits).
This plain-data variant keeps snapshots safe; a program read faults separately.
Core address helpers parse and format addresses, check bounds/type bindings, and
encode/decode little-endian bytes for every supported size.

## Retention contracts

Variable declarations carry optional `retain?: boolean`: true means RETAIN,
false means explicit NON_RETAIN, and omission permits inheritance while lowering.
The compiler expands inherited qualifiers onto flat leaves and standard blocks;
reference and timer exclusions are enforced by the runtime.

`warmRestart` is one command for both warm restart and fault acknowledgement.
`restoreRetentive` carries a complete `records` array and performs initialization
and restoration into STOP. `load.retentive?` performs that restoration atomically
after loading autosaved sources; ordinary loads initialize retained values.

`RetentiveRecord` is either a `leaf` (path, dataType identity, typed value) or a
`block` (path, exact blockType, typed inputs and outputs, boolean/null private
state). Leaf identity includes named type identity and resolved scalar definition,
but excludes string capacity so strings can truncate. `retentive` events carry
complete sets, never deltas. `retentiveRestored.skipped` carries distinct missing,
obsolete or mismatched paths for the UI to report. Retention records are independent
of monitor watches, snapshot compaction, forces and VariableId allocation.

## Function block methods

`UserFunctionBlockIR.methods` holds each `UserMethodIR` once; `methodTable` maps
upper-case names to implementation indices. A method has function-style inputs,
outputs, in-out aliases, an optional result and fresh local variables. Slots below
`memberCount` refer to the receiver's block variables; subsequent slots refer to
`variables`, starting at `memberCount`. Member declarations are not copied into
method definitions. A `userFunctionCall` with `method` indexes that block's methods
with `function`; `method.receiver` selects explicit instance storage, including
indexed or nested instances. Its absence means the current instance (`THIS`).
The checked compiler AST's owner links never cross the IR boundary.

## Class definitions and storage

Classes share `UserFunctionBlockIR`, the `functionBlocks` definition table and
`UserFunctionBlockStorage` with user blocks. `kind: "class"` identifies a class;
`kind` absent (or `"functionBlock"`) identifies a block for compatibility with
existing IR producers. A class has an empty body, input/output lists and temporary
list. Its methods use the same `UserMethodIR`, method table and receiver slots.
The instance's `block` index identifies its actual type, including for arrays and
nested instances. The compiler rejects class body calls before lowering.

Class scalar non-CONSTANT members expand into the same flat monitored variable
table, independent of access. Existing runtime, snapshot, write/force, retention,
web monitor and conformance consumers use that shared layout; no new wire message
or snapshot variant is required.

## Inheritance layout (ADR 0017)

A `UserFunctionBlockIR.base` indexes the same `functionBlocks` table. Its variables
are flattened base first, preserving declaration order and initializers, including
private members and every variable section. Each instance storage record's `block`
is its actual type. Effective `methods` and `methodTable` retain inherited method
slots; an override replaces its slot and new methods append. `abstract` and `final`
record declaration modifiers on types and methods.

A method's `declaringType` identifies its source definition. `memberCount` is the
receiver prefix used by that implementation; its locals start immediately after
that prefix, even on an instance with additional derived members. Call parameter
slots address the statically selected implementation. Virtual dispatch maps each
slot by its ordinal in the input, output or in-out signature to the selected
implementation's corresponding slot; local declarations may differ in number and
position. `method.static` selects the base table for
`SUPER.M()`; other method calls use the receiver's actual table. `superCall.block`
runs that base definition's effective body on the current receiver. `bodyOwner`
identifies the declaration supplying an inherited body and its fault location.
All these fields are plain structured-cloneable data.

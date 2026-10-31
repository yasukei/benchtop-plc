# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until 1.0.0, any release may break compatibility, including saved project files.

## [Unreleased]

### Changed

- Link compliance claims for comments, string escapes, namespace `INTERNAL` access,
  TOD/LTOD conversions and ADR arithmetic/string examples to conformance cases.

- Reject writes to active `FOR` control variables inside the loop body, including
  nested `FOR` reuse, `=>` output targets, `VAR_IN_OUT` actuals and `REF()` arguments,
  with the new `flow.for-control-write` error. Reads and writes after `END_FOR`
  remain allowed.

- Follow IEC 61131-3 Ed. 3 Table 71 by binding unary `+`, `-` and `NOT` before
  `**`. This changes results of accepted ST: `-2 ** 2` and `-x ** 2` with `x = 2`
  now yield 4.0 instead of -4.0. Use `-(2 ** 2)` to retain -4.0.
- Document `pnpm release:prepare <version>` to update package and example versions
  and prepare the dated changelog section and comparison links for a release.
- Document `pnpm test:coverage` for finding untested package source paths, with
  per-package CI totals and a downloadable HTML coverage report.
- Document verification commands, when to run them, and Playwright browser setup
  for fresh clones and containers in the contributor guides. Limit the documented
  runtime baseline command to the benchmarks supported by the baseline commit.
- Development now requires Node.js 26 or later; CI uses the major pinned in
  `.node-version`.
- The public GitHub Pages site now follows published releases instead of every
  push to `main`; manual deployments take an explicit ref.
- **Breaking core protocol change:** `load` requires a per-attempt `loadId`.
  The Worker echoes it only on the initial snapshot or the failed-load fault;
  ordinary command replies omit it.

### Fixed

- Use valid, collision-free internal ST names during project exchange, preserving
  configuration constants and keeping configuration and resource globals in their
  original scopes when identifier rules are tightened.

- Report truncated configuration sources, reserved declaration names and unsupported
  EN/ENO call parameters with diagnostics that identify the cause. Keep parameters
  in rejected CONSTANT sections available to call checking to avoid follow-on errors.

- Show variable types on hover in configured projects with multiple programs,
  including configuration globals and their external declarations.

- Keep semantic diagnostics in other POUs visible while editing a POU body with a
  syntax error, when its complete header and declarations are still known. Damaged
  headers or declarations still stop checking, and syntax errors still prevent IR
  generation.

- Accept formal calls to all registered standard functions, including consecutive
  numbered inputs for extensible functions. Preserve source evaluation order and
  report invalid or incomplete calls without cascading arity or assignment errors,
  while retaining independent input diagnostics. Formal `NOT` also supports constant
  expressions wherever the positional unary operator does.

- Accept equivalent resolved types in override and interface method signatures:
  aliases, matching named/anonymous subranges and different string capacities
  follow ADR 0015, while distinct structures, enumerations and subrange/base types
  remain incompatible.

- Reuse parsed sources and namespace lookups while saving and opening projects,
  avoiding repeated parsing and traversal of every POU in larger projects.

- Show localized warnings when opening a project drops vendor data or replaces
  stale preserved source, showing identical repeated warnings once. Warnings remain
  beside the project controls until dismissed or another project opens successfully.
- Open projects with equivalent ISO 8601 spellings of supported task intervals,
  and explain that implicit configurations support only 10, 20, 50 and 100 ms cycles
  when an imported interval is unsupported.
- Save LTIME, LDATE, LTOD and LDT as `derived` names so project XML validates
  against TC6 v2.01. Files saved with the old type elements still open.
- Check failed nested enumeration operands once, keeping diagnostics proportional
  to the source size and autosave restoration responsive.
- Return a localized diagnostic for source nested beyond 32 syntax levels instead
  of overflowing the stack, including during autosave restoration. The limit
  protects compilation, execution and project exchange; function block instance
  hierarchies have no new language depth limit. Flat operator/access chains use
  a separate 256-level tree-depth budget, so ordinary expressions with dozens of
  terms remain accepted. Project import preserves either source-limit diagnostic
  instead of reporting an invalid POU interface.
- Recover unexpected Worker errors as an internal-error FAULT that can be
  acknowledged or reset without reloading the page. Failed loads complete with
  the same recoverable fault; invalid input values/addresses and unsupported
  cycle settings now produce nonfatal command rejections.

- End FOR loops when their next increment would exceed the control variable's type
  range, preserving the last body value instead of wrapping and reaching the watchdog.
- Pair monitor values with the load that produced them, ignoring delayed
  zero-scan replies from previous programs. Failed loads clear their pending
  state so another project can be opened and loaded. Saved retained values survive
  a failed-load retry, and Acknowledge fault or Cold reset clears its diagnostic.
- Keep debugger halts and snapshots serializable after 64-bit call results, and show
  invalid REAL/LREAL in-out storage in the call stack without disconnecting the Worker.
- Clear the previous project's retained values when opening a project or restoring
  the example, even if the opened source cannot compile before a page reload or a
  runtime command republishes the previous project's values.
- Preserve each POU's breakpoints, instance choice and loaded-line mapping when an
  edited header temporarily uses another POU's name. Deleting a POU also removes
  its saved instance choice.
- Restore autosaved work containing interfaces after a page reload instead of
  falling back to the blink example and overwriting the saved project.

## [0.8.0] - 2026-10-27

Debugging: inline values in every POU body for a chosen instance, breakpoints with a halted state, stepping, the call stack and a sorting conveyor debugging guide. Project files are unchanged; the core protocol between the UI and the runtime changes in breaking ways; see Changed.

### Added

- Sorting conveyor debugging guide with a Playwright acceptance walkthrough,
  covering instance and body values, event breakpoints, halted I/O, stepping,
  the call stack and keyboard shortcuts. The counter block body now publishes
  its total through a `Value` output, preserving the conveyor trace.

- Statement debugging with Step over, Step into and Step out, keyboard shortcuts
  that preserve control focus across halts, and a selectable call stack showing
  invocation values and in-out actual locations.
  Halted inline values now include unwatched bodies.

- Editor gutter breakpoints with active/inactive markers, line tracking through
  edits and POU renames, browser autosave, halted statement highlighting and
  Continue. A halt pauses the whole resource and preserves published outputs,
  which panel lamps, numeric displays and I/O image readings keep showing.

- Inline values inside method and function bodies, with per-instance method calls,
  class instance selection and localized function caller labels. Runtime debugger
  support records every active frame's invocation when debugging is enabled at
  task-run boundaries.

- Choose the instance shown by inline values in PROGRAM and function block sources,
  with a path/type filter, derived instances, autosaved choices and older-scan labels.
- Runtime body watches collect function block statement values, including inherited
  bodies and `SUPER()`, independently for each selected instance.

- Runtime documentation for internal resumable execution and its repeatable
  scan-time benchmark.

- ADR 0018 documents the accepted debugging design for Milestone 8: choosing the
  instance whose inline values a body shows, inline values in every body,
  breakpoints, the halted state, stepping and the call stack.

### Changed

- **Breaking core protocol changes:**
  - Snapshot `annotations` is an array of `{ pou, instance, scanCount, lines }`
    bodies instead of a record keyed by POU. Annotated function bodies add
    `caller: { pou, instance, line }`.
  - `watchBodies` replaces the watched set. Function watches use a null
    instance, and function block and class watches cover all their methods.
    Until the first `watchBodies` after load, the first instance of every
    PROGRAM is watched.
  - `RuntimeState` gains `HALT`. `setBreakpoints`, `continue` and `debugStep`
    are new commands; `step` remains a single scan.
  - The new `halted` event reports the underlying operating state, the task and
    the whole call stack, with each frame's values and invocation annotations.
  - Rejected commands include `run`, `step`, `continue` and `debugStep`, with
    the `runtime.halted` and `runtime.not-halted` codes.
  - PROGRAM IR keeps call-local declaration names for halted value reporting.
- Halted time is excluded from execution times and skipped activations during a
  halt are not overruns. Abandoned task runs leave task telemetry and due times
  unchanged, while their scheduler pass still increments `scanCount`.

## [0.7.0] - 2026-10-26

Classes, methods, interfaces and namespaces: function block methods, classes, single inheritance with dynamic binding, interfaces with assignment attempt, references to instances, namespaces and a sorting conveyor example. Contains breaking changes: 20 new reserved words; see Changed.

### Added

- Sorting conveyor reference project combining namespaced classes, inheritance,
  interface-array dispatch, an instance reference and function block methods with
  retained bin totals. Includes sensor buttons, diverter lamps, numeric displays,
  a virtual-clock conformance trace and a browser acceptance test.

- Namespaces for data types, POUs, classes and interfaces, qualified names and
  USING imports with ordered lexical lookup and ambiguity diagnostics. INTERNAL
  declarations, members and methods respect namespace boundaries. Project files
  preserve exact namespace sources and exchange qualified names; source lists and
  monitor types display qualified names. Structure fields keep their independent
  member names, including names shared with visible types.

- References to user function block and class instances (`REF_TO Motor`, `REF(inst)`
  and `REF(THIS)`). Dereferences support member access, dynamic method calls and
  function block body calls. Derived references assign to base references; `?=`
  casts between instance references and interfaces, clearing mismatches to NULL.
  Instance targets appear as monitor paths and survive project save/reopen.

- Interfaces with method prototypes, multiple interface inheritance and IMPLEMENTS
  for classes and function blocks. Interface variables bind persistent instances,
  dispatch methods dynamically, compare identities and support assignment attempt
  (`?=`), which clears the target on mismatch. Monitor targets as paths or NULL;
  add interface sources from a template and preserve them in project files.
  PROGRAM interface in-outs bind exact-type mutable globals through configuration
  connections and share their storage immediately; unbound in-outs are rejected.

- Single inheritance for function blocks and classes with EXTENDS, dynamic method
  overrides, SUPER method/body calls, ABSTRACT and FINAL. Inherited members retain
  their initializers and retention qualifiers and appear base first in the monitor.
  Project files preserve exact inheritance sources; TC6 elements contain only each
  type's own variables. Faults identify the source declaring the inherited code.

- Classes with persistent members, methods and THIS, instance arrays and globals,
  access checks and RETAIN/NON_RETAIN restart behavior. Add a class from the source
  list and monitor, write or force its members regardless of access. Project files
  keep exact class sources; other TC6 tools see empty function blocks.

- ADR 0017 documents the accepted design for methods, classes, inheritance,
  interfaces, references to instances and namespaces for Milestone 7.
- Function block methods with instance storage, fresh call-local variables,
  formal and positional parameters, return values, access specifiers and THIS.
  Method calls show inline values in PROGRAM bodies; monitor access stays unrestricted.
  Project files preserve exact methods and access in the source extension.
  THIS-qualified member instances and indexed elements support body calls, and
  their bounds faults identify the member array in the instance path.

### Changed

- INTERFACE, END_INTERFACE, IMPLEMENTS, CLASS, END_CLASS, EXTENDS, OVERRIDE, SUPER,
  ABSTRACT, FINAL, METHOD, END_METHOD, THIS, PUBLIC, PROTECTED, PRIVATE, INTERNAL,
  NAMESPACE, END_NAMESPACE and USING are now reserved. Texts in 0.6.0 project files
  that use them as names open as editable drafts, from the preserved source text or,
  when it is absent, from text generated from the standard elements. Autosave keeps
  drafts; rename the identifiers before running or exporting the project.

## [0.6.0] - 2026-10-25

Configurations, tasks and global variables: configuration sources with several program instances, cyclic and event tasks, global variables, PROGRAM parameters, byte, word and memory addresses, numeric panel parts, and retentive variables with warm restart. Contains a breaking change to monitor paths; see Changed.

### Added

- Tank station reference project combining two parameterized tank controllers,
  fast control and slower statistics tasks, an alarm acknowledge event task,
  shared globals and a high-level constant, `%M` pump flags, numeric panel
  controls and retentive run-time counters with virtual-clock and browser tests.

- RETAIN and NON_RETAIN declarations, warm restart and fault acknowledgement into
  STOP. Retained scalars and counter/edge/bistable state survive browser reloads;
  timers and references reset. Browser storage saves complete retained sets at most
  once per second during execution and after state-changing commands, reports
  restore mismatches by path until the next load or reset, and warns on storage
  failures. PLCopen XML preserves retention qualifiers on POU and global variable lists.

- Numeric operator panel inputs and displays for byte, word, double-word and
  long-word I/O, with type validation, exact 64-bit integer entry, optional input
  bounds and sliders, and monitor formatting for outputs and invalid real values.
  The panel editor configures their labels, types and addresses; numeric layouts
  save as panel extension version 2 while legacy layouts keep their version rules.
  New parts default to free addresses that avoid existing bit and numeric bindings.

- Typed direct addresses in 64-byte input/output areas and a 1,024-byte memory
  area, with shared overlapping views, little-endian byte/word/double-word/long-word
  access, and warnings for overlapping output writers. Invalid REAL/LREAL patterns
  fault on program reads and display safely with raw bits in the monitor. The I/O
  image shows used addresses in their declared types. Panel bit controls support
  every I/O byte; projects save the address-based panel extension version 2 only
  when needed and retain version 1 compatibility for byte-zero layouts. Imported
  panel addresses are normalized so address selection and automatic bindings stay
  consistent.

- Up to 16 cyclic and rising-edge event tasks with non-preemptive priority
  scheduling, independent intervals, missed-activation overrun counts and task-level
  I/O boundaries. Single scans cover every cyclic task and rising event input;
  faults stop the whole resource and identify the task. The status area displays
  per-task run counts, last/maximum execution times and overruns in English/Japanese.
  Inline values stay visible between runs of slower and event tasks and refresh
  when their program's first instance runs again.

- PROGRAM inputs and outputs with per-instance configuration connections to
  constants, globals and direct addresses. Values copy around each
  instance with forces restored at every boundary. Connected inputs reject monitor
  writes and accept forces; unconnected inputs keep their values. PLCopen XML
  preserves program interfaces and exact connection source text. Direct addresses
  connect in the configuration; `AT` on PROGRAM input/output declarations is rejected.
  Connection lists reject empty parentheses and trailing commas.

- Configuration and resource global variables and constants, imported by PROGRAMs
  and function blocks through VAR_EXTERNAL. Globals share storage across instances,
  support derived types, references, FBs and direct addresses, and appear in
  a Globals monitor group with write and force controls. PLCopen XML preserves global
  and external declarations and CONSTANT attributes; imported constants work in
  array bounds and CASE labels. Invalid global declarations report configuration
  errors without cascading missing-global messages in importing POUs.

- Configuration source editing in the web source list, with one cyclic-task
  template containing every PROGRAM, header-based renaming, diagnostic navigation
  and confirmed deletion back to implicit mode. Browser autosave preserves
  configuration drafts and selection and migrates 0.5.0 records unchanged.

- PLCopen XML save/open for exact configuration sources, multiple tasks and program
  instances, and event task inputs. Imports without preserved text reconstruct
  configuration source when the implicit model cannot represent the structure.
  The web app compiles imported configurations, keeps them through autosave and
  hides the implicit cycle selector while a configuration source is present.

- Configuration source compilation with one resource and up to 64 independent
  program instances sharing their PROGRAM bodies. Configured task intervals drive
  runtime execution; explicit configurations reject cycle commands.
  Existing projects use an implicit configuration and keep their cycle control.

- ADR 0016 documents the accepted design for configurations, tasks and scheduling,
  global variables, program parameters, byte, word and memory addresses, retentive
  variables and warm restart for Milestone 6.

### Changed

- Monitor and reference paths are now qualified by program instance, including
  `mainInstance.LAMP` in existing projects. The monitor groups instances and shows
  relative paths within each group. Inline values identify their instance and
  annotations are keyed by POU and line, using the first instance of each PROGRAM.

## [0.5.0] - 2026-10-24

Derived data types and strings: enumerations, subranges, arrays, structures, strings and references, with PLCopen XML exchange and monitor support for composite variables. Contains breaking changes to accepted Structured Text; see Changed.

### Added

- Batch mixer reference project combines an enumerated CASE state machine, three
  initialized recipe structures in an array, a latched recipe reference, TON step
  timers and CONCAT status messages. Includes panel controls and lamps,
  virtual-clock traces for every recipe and STOP/restart, and a browser test for
  operation, monitor values and exact text preservation on save/reopen.

- References (`REF_TO`, `REF`, `^`, `NULL`) to persistent variables, elements and
  members, including reference parameters/results, `MOVE`/`SEL`/`MUX` selection,
  dereferenced in-out arguments and recursive structures.
  Reference targets match exactly; NULL dereferences fault with POU/instance
  diagnostics. Monitoring displays target paths or NULL without write/force
  controls, and PLCopen XML exchanges references as pointer types.

- Arrays and structures as copied input/output parameters, in-out aliases and whole
  function results. Open `ARRAY[*]` in-outs accept caller arrays with different
  bounds, with DINT `LOWER_BOUND`/`UPPER_BOUND` queries. Element/member aliases
  preserve caller storage, string capacities and force behavior; PLCopen XML
  round-trips aggregate interfaces and open dimensions.

- Diagnostics name the actual block type when a scalar instance is indexed, and
  explain unsupported named/nested function block arrays once per declaration in
  English and Japanese.

- Arrays of standard and user function block instances in PROGRAM and function
  block VAR sections, with indexed calls and public port access, independent
  persistent state, shared timer/counter variant selection and cold reset of
  every instance tree. The monitor groups element paths and supports member
  writes/forces; PLCopen XML preserves arrays with derived block base types.

- Structure declarations report unsupported function block member types on the
  type name, with an explanation of the restriction in English and Japanese.

- Named structures with member defaults, nested array/member access, partial
  initializers, and whole-structure assignment/MOVE/SEL/MUX. The monitor expands
  structures and arrays of structures and supports scalar member writes and
  forces. PLCopen XML preserves nested structure declarations and initial values.

- Array diagnostics distinguish non-array access, index counts, non-integer
  indices and missing initializer lists, with the relevant types and counts.

- Arrays with constant DINT bounds, up to three dimensions and 10,000 scalar
  leaves, nested arrays, repeated initializers, checked indexing, element bit
  access and whole-array assignment/MOVE/SEL/MUX. Array elements support strings,
  enumerations and subranges. The monitor expands arrays and writes/forces
  individual elements; snapshots include watched or forced elements. Editor
  hovers show array types, and PLCopen XML preserves array types and initial values.

- Standard STRING/WSTRING functions LEN, LEFT, RIGHT, MID, extensible CONCAT,
  INSERT, DELETE, REPLACE and FIND, with checked positions, clamped lengths and
  results up to 1,024 code units. CHAR/WCHAR inputs widen to their string types.
  Elementary values convert to and from text using
  the monitor format and literal syntax; character/code-unit conversions and
  overloaded TO_ forms are supported. Invalid conversions fault without wrapping.

- STRING, STRING[n], WSTRING, WSTRING[n], CHAR and WCHAR variables, aliases,
  constants and POU parameters/results, with quoted literals and dollar escapes.
  Comparisons, selection and ordering functions support character data; dynamic
  string stores truncate to capacity. The monitor displays quoted text and validates
  quoted writes and forces, inline values preserve string types, the editor
  highlights literals, and PLCopen XML preserves capacities and character types.

- Data types appear before POUs in the web editor, with templates, text-based
  renaming, confirmed deletion and diagnostic navigation. Project-wide Run,
  type highlighting and variable hovers include declared types; autosave keeps
  unfinished type drafts and restores older POU autosaves.

- PLCopen XML saves and opens ordered data type sources, including enumerations,
  named and inline integer subranges, elementary and derived aliases, and their
  initial values. Source extensions preserve exact text; imports without them
  rebuild equivalent TYPE declarations. The web app retains imported types for
  compilation, monitoring, browser autosave and project save/open.

- Compiler data type sources with elementary aliases, enumerations and named or
  inline integer subranges (ADR 0015). Enumerations support contextual literals,
  CASE, selection functions and scalar POU parameters/results; subrange stores
  fault outside their limits. Monitor helpers format enum names and validate
  writes and forces.

- ADR 0015 documents the accepted design for data type declarations, enumerations,
  subranges, arrays, structures, strings and references for Milestone 5.

### Changed

- Breaking: CHAR, WCHAR, REF_TO, REF and NULL are now reserved keywords (ADR 0015).
  The standard namespace also reserves LEN, LEFT, RIGHT, MID, CONCAT, INSERT,
  DELETE, REPLACE, FIND, LOWER_BOUND, UPPER_BOUND, TO_STRING, TO_WSTRING, TO_CHAR, TO_WCHAR and the
  ADR 0015 character/string conversion names, including `<type>_TO_STRING`,
  `<type>_TO_WSTRING`, `STRING_TO_<type>` and `WSTRING_TO_<type>`. Existing identifiers
  using these names must be renamed. STRING and WSTRING remain reserved; string
  functions/conversions and references are available.

### Fixed

- Compiler diagnostics name the actual standard or user function block type in
  structure array members, identify containment and alias cycles without
  cascading unknown-type errors, and explain the restriction on subrange FOR
  control variables in English and Japanese.

## [0.4.0] - 2026-10-23

User-defined functions and function blocks in projects with several POUs, with `VAR_IN_OUT`, `VAR_TEMP`, `CONSTANT` and timers and counters that adapt to their preset type. Contains breaking changes to accepted Structured Text; see Changed.

### Added

- Motor starters example with two independent instances of a user-defined
  function block, nested TON start delays, a shared interlock function,
  START/STOP and overload controls, status lamps and virtual-time traces.

- Overloaded `TON`, `TOF`, `TP`, `CTU`, `CTD` and `CTUD` select timer/counter
  variants from typed `PT`/`PV` bindings in their declaring POU, including user
  function blocks. Monitor rows and editor hovers show resolved types; PLCopen XML
  preserves the declared names and selects again on open. Failed selection reports
  the incompatible preset types without misleading default-variant narrowing errors.

- `VAR CONSTANT` in programs, functions and function blocks: typed compile-time
  values with default initializers, earlier-constant references and wrapping
  arithmetic. Constants work in initializers, CASE labels, bit indices and FOR
  bounds/step, with no runtime storage or monitor entries; writes are rejected.
- PLCopen XML constant sections, including canonical imports and initializer
  validation in the context of earlier constants in each POU.

- `VAR_IN_OUT` parameters on functions and function blocks, passed as exact-type
  caller variable aliases on every formal call. Writes are visible immediately,
  aliases can be passed on, and monitoring and forces use the actual variable's ID.
  In-out declaration initializers are rejected because values belong to the caller.
- Save and open in-out sections as PLCopen XML `inOutVars`, including canonical
  imports without preserved source.

- User-defined function blocks with independent persistent instances, nested user
  and standard blocks, per-call VAR_TEMP, and PROGRAM VAR_TEMP per scan.
- Named `=>` output bindings on user and standard function block calls, with
  implicit assignment widening.
- Dotted monitor members with writes and forces, instance paths in runtime faults,
  and PROGRAM inline output values for user function block calls.
- Add function blocks from the POU list and preserve block POUs, nested instances
  and temporary sections in PLCopen XML.

- Manage project POUs beside the ST editor: add and delete functions, switch texts,
  navigate project-wide diagnostics, and preserve all drafts in browser autosave
  with migration from 0.3.0 single-program work.

- Save and open an ordered collection of programs and functions in PLCopen TC6
  XML, preserving each POU's exact editor text, input/output declarations and
  optional function result type. Existing 0.3.0 project files remain readable.
- Save and reopen parseable projects with semantic errors, including missing
  functions, duplicate names and zero or several programs. Initializer range
  errors still block exchange. The web editor retains the other imported POUs.

- Compile a project from several POU sources with user-defined functions, formal
  input defaults, output bindings, nested calls and fresh local storage per call.
  The web editor shows one POU at a time.
- Compiler and runtime diagnostics identify the source POU; the editor displays
  that name alongside the location.

- ADR 0014 documents the accepted design for user-defined POUs, calls, instance
  memory, project exchange and monitoring for Milestone 4.

### Changed

- POU names share a case-insensitive namespace with standard functions, function
  blocks and elementary types. Variables cannot reuse a POU name, including the
  PROGRAM name. PROGRAM parameters and function recursion are compile errors.

### Fixed

- Saving imported PLCopen projects stamps the company, product name and version
  together as benchtop-plc's writer identity and removes imported company URLs and
  product release strings. Creation time, content description and the content
  header are preserved. A foreign product name or company URL is no longer paired
  with benchtop-plc's version.

## [0.3.0] - 2026-10-22

All elementary data types except strings, with the standard's conversion and literal rules and the standard functions and function blocks for them. Contains breaking changes to accepted Structured Text; see Changed.

### Changed

- Conversion portability warnings now name the resolved function and explain the
  rightmost-bit or bit-pattern behavior in English and Japanese, including overloaded
  `TO_` calls. Warnings allow programs to load and run.

- New standard function names (including SUB, EQ and LT) are reserved against
  variable declarations; existing programs using those names must rename them.

- **Breaking:** AND, &, OR, XOR and NOT now accept BOOL and bit strings only;
  integer operands require an explicit conversion to a bit-string type.
- Runtime initial values and write/force commands reject out-of-range values for
  every supported type. Project imports and exports reject out-of-range initializers.

- TIME is now signed 32-bit milliseconds. Out-of-range duration literals, IR initial
  values and write/force values are rejected. TIME arithmetic wraps modulo 2^32;
  real scaling rounds the exact result once to milliseconds, nearest with ties to even.

- Narrowing assignments and typed inputs now require explicit conversions. Numeric
  operators and generic functions use ADR 0013 common types; REAL + LREAL is LREAL.
- Untyped constants are evaluated exactly and checked against the type supplied by
  their position. Out-of-range constants are errors instead of silently wrapping.
  Real constants round directly to binary32 or binary64, once. Decimal scales
  outside ±10,000 are rejected before allocation to keep compilation responsive.
- Octal literals (`8#`) are rejected.

### Added

- Running light example project with START/STOP, a direction selector, eight LEDs,
  BYTE rotations and bit access, a UDINT rotation counter and virtual-time traces.

- Standard SR/RS bistables, CTUD, typed CTU/CTD/CTUD counters for INT, DINT,
  LINT, UDINT and ULINT, and TON/TOF/TP_TIME and _LTIME timers. Counters saturate
  at type limits; long timers use nanoseconds from the injected clock, subject
  to host clock resolution. All new blocks round trip through PLCopen XML and
  expose typed monitor ports. Their names are reserved against declarations.

- Standard time/date arithmetic and long forms, calendar constructors, component
  splitting and DAY_OF_WEEK. Function calls support statements and SPLIT output
  assignments with `=>`; INT outputs widen implicitly and the result is BOOL.
  Missing formal inputs report one arity error; unsupported FB call syntax reports
  that named `:=` inputs are required.

- Standard numeric and arithmetic functions, `**` exponentiation, width-aware
  shifts/rotates, bitwise calls, MOVE/MUX and comparison functions, including
  exact 64-bit arithmetic. Selection functions now cover all compatible elementary
  types, including BOOL and calendar values. Typed TRUNC and packed BCD conversion
  families wrap integer results and fault on invalid input.

- DATE, TOD, DT, LDATE, LTOD and LDT throughout the compiler, runtime, variable
  monitor and PLCopen XML, with Gregorian literals (including unpadded fields and
  underscore separators), calendar conversions, exact
  nanosecond long values, chronological comparisons and duration arithmetic.
  Times of day wrap within one day; out-of-range dates fault. Calendar defaults
  use the Unix epoch or midnight.

- LINT, ULINT, LWORD and LTIME throughout the compiler, runtime, variable monitor
  and PLCopen XML, with exact 64-bit arithmetic and JSON-safe decimal strings.
  LTIME supports nanosecond literals and exact real scaling; LWORD supports all
  64 bits. Numeric, bit-pattern and duration conversions include overloaded TO_
  forms and LREAL ↔ LWORD reinterpretation. DINT + UDINT now has common type LINT.

- SINT, USINT, UDINT, BYTE, WORD and DWORD throughout the compiler, runtime,
  PLCopen XML and variable monitor, with typed literals, width-based wrapping,
  unsigned 32-bit values and full-width hexadecimal display for bit strings.
- Bit-string operators, comparisons and readable/writable bit access (`w.15`).
- Numeric, bit-pattern and TIME conversion families for the new types, including
  overloaded TO_ forms and REAL ↔ DWORD IEEE binary32 reinterpretation.
  Portability warnings identify conversions whose vendor semantics may differ.
- Monitor writes and forces for the new types; bit strings accept decimal,
  hexadecimal (`16#`) and binary (`2#`) input.

- Typed literals for BOOL, INT, DINT, UINT, REAL and LREAL, including based integers,
  with editor highlighting; integer constants 0/1 in BOOL positions and BOOL ordering.
- Explicit and overloaded conversions across the supported numeric types,
  BOOL to integer conversions, and TIME ↔ integer extensions in milliseconds.

- ADR 0012 documents the planned elementary data types, ranges, defaults and
  overflow rules for Milestone 3.
- ADR 0013 documents the planned implicit and explicit conversions, literal
  typing and operators for Milestone 3.
- An IEC 61131-3 compliance table documents current language support, limits and
  implementation-dependent choices.

## [0.2.0] - 2026-10-20

Release process, workflow security checks, automated dependency updates and a public demo. No language changes.

### Added

- A public demo at https://yasukei.github.io/benchtop-plc/ always runs the latest
  `main` in the browser.

### Fixed

- Direct addresses such as `%IX0.0` are now highlighted in the editor, and the
  browser console no longer warns about an unknown highlighting tag.
- Saved PLCopen projects now identify the writing app's package version, including
  when resaving older projects, while preserving unrelated project metadata.

## [0.1.0] - 2026-10-18

First release: the single-file HTML prototype rebuilt as a tested monorepo.

### Added

- Structured Text compiler with diagnostics: one `PROGRAM`, the types `BOOL`,
  `INT`, `DINT`, `UINT`, `REAL`, `LREAL` and `TIME`, and the statements `IF`,
  `CASE`, `FOR`, `WHILE`, `REPEAT`, `EXIT` and `RETURN`.
- Scan-cycle runtime with the operating states STOP, RUN and FAULT and an
  emergency-stop overlay.
- Standard function blocks `TON`, `TOF`, `TP`, `R_TRIG`, `F_TRIG`, `CTU` and
  `CTD`, and the standard functions `ABS`, `MIN`, `MAX`, `LIMIT`, `SEL` and basic
  type conversions.
- Debugging: force and write variables, single scan, and live values shown next
  to the source.
- Operator panel with LEDs, push buttons, selector switches and an emergency
  stop on the bits `%IX0.0`–`%IX0.7` and `%QX0.0`–`%QX0.7`, plus an I/O image and
  a variable monitor.
- Open and save projects as PLCopen XML (TC6 v2.01).
- English and Japanese user interface.
- Work is saved automatically in the browser, and the theme follows the system
  setting unless you choose Light or Dark.
- The app opens with the blink example and its panel.

[Unreleased]: https://github.com/yasukei/benchtop-plc/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/yasukei/benchtop-plc/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/yasukei/benchtop-plc/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/yasukei/benchtop-plc/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/yasukei/benchtop-plc/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/yasukei/benchtop-plc/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/yasukei/benchtop-plc/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yasukei/benchtop-plc/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yasukei/benchtop-plc/releases/tag/v0.1.0

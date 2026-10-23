# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until 1.0.0, any release may break compatibility, including saved project files.

## [Unreleased]

### Added

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
  writes and forces. The web editor lists these types alongside POUs.

- ADR 0015 documents the accepted design for data type declarations, enumerations,
  subranges, arrays, structures, strings and references for Milestone 5;
  implementation follows in its sub-issues.

### Changed

- Breaking: CHAR, WCHAR, REF_TO, REF and NULL are now reserved keywords (ADR 0015).
  The standard namespace also reserves LEN, LEFT, RIGHT, MID, CONCAT, INSERT,
  DELETE, REPLACE, FIND, LOWER_BOUND, UPPER_BOUND, TO_STRING, TO_WSTRING, TO_CHAR, TO_WCHAR and the
  ADR 0015 character/string conversion names, including `<type>_TO_STRING`,
  `<type>_TO_WSTRING`, `STRING_TO_<type>` and `WSTRING_TO_<type>`. Existing identifiers
  using these names must be renamed. STRING and WSTRING remain reserved; string
  functions/conversions are available; reference implementations follow separately.

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

[Unreleased]: https://github.com/yasukei/benchtop-plc/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/yasukei/benchtop-plc/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/yasukei/benchtop-plc/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/yasukei/benchtop-plc/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/yasukei/benchtop-plc/releases/tag/v0.1.0

# IEC 61131-3 compliance

benchtop-plc targets IEC 61131-3, 4th edition (2025). This page lists the language
features and whether they are supported. It is updated in the same pull request
that changes a feature. The table describes the current implementation; an accepted
ADR can specify behavior that has not been implemented yet.

The 4th edition text was not available when this page was first written. Where a row
depends on the standard's details, it is based on the 3rd edition text and secondary
sources on the changes in the 4th edition, and its Notes say so.

Status: **Yes** – supported · **Partial** – supported with the limits in Notes ·
**No** – not yet supported · **Never** – deliberately not supported.

## Languages

| Feature                         | Status  | Notes                      |
| ------------------------------- | ------- | -------------------------- |
| Structured Text (ST)            | Partial | See the sections below     |
| Ladder Diagram (LD)             | No      |                            |
| Function Block Diagram (FBD)    | No      |                            |
| Sequential Function Chart (SFC) | No      |                            |
| Instruction List (IL)           | Never   | Removed in the 4th edition |

## Common elements

| Feature                       | Status | Notes |
| ----------------------------- | ------ | ----- |
| Comments `(* *)`, nested      | Yes    |       |
| Comments `//`                 | Yes    |       |
| Pragmas `{ }`                 | No     |       |
| Identifiers, case-insensitive | Yes    |       |

## Elementary data types

| Type                                            | Status | Notes                                                                          |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------------------ |
| BOOL                                            | Yes    |                                                                                |
| INT, DINT, UINT                                 | Yes    |                                                                                |
| SINT, USINT, UDINT                              | Yes    |                                                                                |
| LINT, ULINT                                     | Yes    | Canonical decimal strings, bigint arithmetic                                   |
| BYTE, WORD, DWORD                               | Yes    | Unsigned bit patterns, formatted with full-width hexadecimal digits            |
| LWORD                                           | Yes    | 64-bit patterns, hexadecimal display and bit access through bit 63             |
| REAL, LREAL                                     | Yes    | REAL uses binary32 at every result; LREAL uses binary64                        |
| TIME                                            | Yes    | Signed 32-bit milliseconds (ADR 0012)                                          |
| LTIME                                           | Yes    | Signed 64-bit nanoseconds; LT#/LTIME#, including us/ns                         |
| DATE, TIME_OF_DAY, DATE_AND_TIME and long forms | Yes    | ADR 0012 ranges; TOD/DT/LTOD/LDT aliases; long forms use exact nanoseconds     |
| CHAR, WCHAR, STRING, WSTRING                    | Yes    | ADR 0015: single-byte or UTF-16 code units; default capacity 80, maximum 1,024 |

## Literals

| Feature                                          | Status  | Notes                                                                                                                 |
| ------------------------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------- |
| Integer literals, decimal, `2#` and `16#`        | Partial | Exact constants, typed by position (ADR 0013); checked against the resulting type                                     |
| Octal literals `8#`                              | Never   | Removed in the 4th edition (secondary source); rejected with `lex.malformed-number`                                   |
| Real literals with exponent                      | Yes     |                                                                                                                       |
| Boolean literals `TRUE`, `FALSE`                 | Yes     |                                                                                                                       |
| Boolean literals `0`, `1`                        | Yes     | Integer constants in BOOL positions                                                                                   |
| Duration literals `T#`, `TIME#`, `LT#`, `LTIME#` | Yes     | Units d/h/m/s/ms, plus us/ns for LTIME; exact range checks precede TIME truncation                                    |
| Typed literals `<type>#<value>`                  | Partial | All supported elementary types; based integer and bit-string forms included                                           |
| Date and time-of-day literals                    | Yes     | All short and full prefixes; unpadded fields and underscore separators; Gregorian dates, precision and ranges checked |
| String and character literals                    | Yes     | Single/double quotes, typed prefixes, dollar escapes; CHAR/WCHAR require one code unit (ADR 0015)                     |

## Derived types and variables

| Feature                                         | Status  | Notes                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VAR` with initial values                       | Partial | Scalar constant expressions including conversion calls; other calls and FB initializers are rejected                                                                                                                                                                                                                                              |
| Directly represented variables `%I`, `%Q`, `%M` | Partial | PROGRAM VAR and configuration/resource globals; X/B/W/D/L bind BOOL, corresponding integer/bit-string widths and REAL/LREAL; aliases allowed. I/Q: 64 bytes; M: 1,024. Unit numbering, little-endian storage and Q overlap warnings (ADR 0016 restrictions); no hierarchical/partial addresses or AT on FBs, temporaries, constants or parameters |
| `VAR_INPUT`, `VAR_OUTPUT`                       | Partial | Scalar/array/structure function parameters, FB ports and PROGRAM parameters; per-instance configuration connections; PROGRAM VAR_IN_OUT rejected (ADR 0016)                                                                                                                                                                                       |
| `VAR_TEMP`                                      | Partial | PROGRAM: fresh each scan; FUNCTION_BLOCK: fresh each call; forbidden in functions; FB instances forbidden in VAR_TEMP (restrictions)                                                                                                                                                                                                              |
| `VAR_IN_OUT`                                    | Partial | Scalar/array/structure FUNCTION/FUNCTION_BLOCK aliases; exact-type variable/element/member/dereference required every call; formal only, no initializers or instance/bit actuals (restrictions)                                                                                                                                                   |
| `VAR_GLOBAL`, `VAR_EXTERNAL`                    | Partial | Configuration/resource globals; PROGRAM/FB externals with exact types and CONSTANT matching. Shared storage, derived types, references, FBs and bit addresses; FUNCTION externals rejected; RETAIN deferred (ADR 0016)                                                                                                                            |
| `CONSTANT`                                      | Partial | Elementary, string, character, alias, enum and subrange typed constants, on `VAR`, configuration/resource `VAR_GLOBAL`, and matching `VAR_EXTERNAL`; no `AT` or FB instances. Earlier constants only; folded without runtime storage (ADR 0014, ADR 0016)                                                                                         |
| `RETAIN`, `NON_RETAIN`                          | No      |                                                                                                                                                                                                                                                                                                                                                   |
| `TYPE` declarations                             | Partial | One type per separate compiler source, ordered before POUs; case-insensitive shared namespace; elementary aliases and defaults (ADR 0015). PLCopen XML exchanges these sources; the web app lists and edits them before the POUs.                                                                                                                 |
| Enumerations                                    | Partial | Implicit/explicit integer values, qualified/contextual literals, assignment, equality, CASE, MOVE/SEL/MUX, scalar POU parameters/results and CONSTANT; no ordering, conversion or enum ranges (restrictions; 3rd edition basis).                                                                                                                  |
| Subranges                                       | Partial | Named/inline integer limits, lower-bound defaults, constant checks and runtime store faults; exact in-outs compare base and limits; forbidden as FOR controls (restriction; 3rd edition basis).                                                                                                                                                   |
| Arrays                                          | Partial | Up to three dimensions, 10,000 scalar leaves, nested arrays, initializers, indexing and whole-array assignment/selection; inline function block instance arrays with indexed calls and per-element state (ADR 0015).                                                                                                                              |
| Structures                                      | Partial | Named structures, member defaults, nested array/member access, initializers, whole-structure assignment/MOVE/SEL/MUX and scalar monitoring (ADR 0015).                                                                                                                                                                                            |
| Variable-length arrays                          | Partial | `ARRAY[*, ...]` only in direct VAR_IN_OUT, matching rank/element types, actual bounds and DINT LOWER_BOUND/UPPER_BOUND with constant dimension (ADR 0015; 3rd edition basis).                                                                                                                                                                     |
| References                                      | Partial | `REF_TO`, `REF`, `^`, `NULL`, exact target types, identity equality, MOVE/SEL/MUX, dereferenced in-outs, parameters/results and recursive structures (ADR 0015). Persistent targets only; no instance references, assignment attempts, allocation or pointer arithmetic (restrictions; 3rd edition basis).                                        |

## Program organization units

| Feature                      | Status  | Notes                                                                                                                                                                      |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROGRAM`                    | Partial | One implicit PROGRAM or 1–64 configured instances; VAR_INPUT/VAR_OUTPUT connections; no PROGRAM VAR_IN_OUT or AT on parameters (restrictions)                              |
| `FUNCTION`                   | Partial | Multi-source compilation; scalar inputs, outputs, in-outs and result or no result; fresh locals, defaults, formal/positional calls and RETURN; no FB instances or VAR_TEMP |
| `FUNCTION_BLOCK`             | Partial | Persistent independent instances; arbitrary acyclic nesting; VAR_INPUT/VAR_OUTPUT/VAR_IN_OUT/VAR/VAR_TEMP; no direct addresses (restrictions)                              |
| Classes, methods, interfaces | No      |                                                                                                                                                                            |
| Namespaces                   | No      |                                                                                                                                                                            |

## Operators and statements (ST)

| Feature                                       | Status | Notes                                                                                                                                                                                                                                                                |
| --------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `+ - * / MOD`, unary `+` and `-`              | Yes    | MOD accepts integers only; TIME/LTIME support duration addition/subtraction, scaling by a numeric right operand, and unary signs (minus rejects unsigned integers); calendar differences yield TIME/LTIME, TOD/DT ± duration select the narrowest matching signature |
| `**`                                          | Yes    | ANY_REAL base, independent ANY_NUM exponent; untyped integer base becomes LREAL; result has the base type (ADR 0013)                                                                                                                                                 |
| `AND`, `&`, `OR`, `XOR`, `NOT`                | Yes    | BOOL and BYTE/WORD/DWORD/LWORD only; operands use their common bit type; `&` is an alias for AND                                                                                                                                                                     |
| Comparisons                                   | Yes    | Common type per ADR 0013; BOOL ordering is `FALSE < TRUE`; calendar values compare chronologically                                                                                                                                                                   |
| Bit access `x.n`                              | Yes    | BYTE/WORD/DWORD/LWORD variables; a constant index within the width, readable and writable                                                                                                                                                                            |
| Assignment `:=`                               | Yes    | Only ADR 0013 widening is implicit; narrowing needs an explicit conversion                                                                                                                                                                                           |
| Function calls as statements and `=>` outputs | Yes    | User and standard functions and FBs: writable outputs follow assignment widening; FB inputs remain formal only                                                                                                                                                       |
| FB call with named inputs                     | Yes    |                                                                                                                                                                                                                                                                      |
| `IF`, `CASE`, `FOR`, `WHILE`, `REPEAT`        | Yes    | CASE selectors and labels, and FOR variables and bounds, must be integers; CASE labels must be constant                                                                                                                                                              |
| `EXIT`, `RETURN`                              | Yes    | RETURN leaves the current POU                                                                                                                                                                                                                                        |
| `CONTINUE`                                    | No     |                                                                                                                                                                                                                                                                      |

## Standard functions

| Feature                                                                                    | Status  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ABS`, `MIN`, `MAX`, `LIMIT`, `SEL`                                                        | Yes     | ABS: ANY_NUM; selection: all compatible supported elementary types, including BOOL and calendar types; set-based common type (ADR 0013)                                                                                                                                                                                                                                                                                                                                                                                                   |
| Type conversion                                                                            | Partial | All supported numeric pairs; BOOL → integer; BOOL/bit-string pairs; integer ↔ bit string; REAL ↔ DWORD and LREAL ↔ LWORD bit reinterpretation; overloaded TO_ forms. TIME ↔ integer (milliseconds) and LTIME ↔ integer (nanoseconds) are extensions; TIME ↔ LTIME changes resolution; calendar conversion families and overloaded forms are supported; STRING/WSTRING ↔ every non-character elementary type, STRING ↔ WSTRING, CHAR ↔ STRING, WCHAR ↔ WSTRING, CHAR ↔ WCHAR, CHAR ↔ BYTE and WCHAR ↔ WORD, including overloaded TO_ forms |
| Numeric (`SQRT`, `LN`, `LOG`, `EXP`, `SIN`, `COS`, `TAN`, `ASIN`, `ACOS`, `ATAN`, `ATAN2`) | Yes     | ANY_REAL; radians; ATAN2(y, x); non-finite results fault                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Arithmetic (`ADD`, `MUL`, `SUB`, `DIV`, `MOD`, `EXPT`, `MOVE`)                             | Yes     | ADD/MUL extensible; MOD: ANY_INT only; EXPT as `**`; MOVE: ANY_ELEMENTARY                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Bit shift (`SHL`, `SHR`, `ROL`, `ROR`)                                                     | Yes     | ANY_BIT with independent ANY_INT count; width-based zero fill or rotation, including 64 bits                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Bitwise call forms (`AND`, `OR`, `XOR`, `NOT`)                                             | Yes     | ANY_BIT, including BOOL; AND/OR/XOR extensible                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Selection (`MUX`) and comparison (`GT`, `GE`, `EQ`, `LE`, `LT`, `NE`)                      | Yes     | Compatible ANY_ELEMENTARY including BOOL and calendar types; all comparisons except NE extensible; MUX selector is ANY_INT                                                                                                                                                                                                                                                                                                                                                                                                                |
| `TRUNC_<B>`, `<A>_TRUNC_<B>`                                                               | Yes     | ANY_REAL → ANY_INT, toward zero then wraps; no constant evaluation                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Untyped `TRUNC(x)`                                                                         | Never   | Removed in the 4th edition (secondary source); use a destination-typed TRUNC form                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `<A>_BCD_TO_<B>`, `<A>_TO_BCD_<B>`                                                         | Yes     | All integer/bit-string pairs except BOOL; packed unsigned BCD; invalid digits or negative encoding inputs fault; results wrap                                                                                                                                                                                                                                                                                                                                                                                                             |
| Time and date functions                                                                    | Yes     | Named duration/calendar arithmetic and long forms; CONCAT, SPLIT with INT outputs and BOOL result, DAY_OF_WEEK (0 = Sunday); constructors and splits use millisecond components                                                                                                                                                                                                                                                                                                                                                           |
| String functions                                                                           | Yes     | LEN, LEFT, RIGHT, MID, extensible CONCAT, INSERT, DELETE, REPLACE and FIND for STRING/WSTRING; ADR 0015 positions, clamping and faults; results capped at 1,024 code units                                                                                                                                                                                                                                                                                                                                                                |

## Standard function blocks

Names in this section follow the IEC 61131-3 3rd-edition function block families,
consistent with PLCnext's typed timer names. CODESYS aliases LTON/LTOF/LTP are
not provided. Overloaded names select from typed PT/PV calls and member assignments
within the declaring PROGRAM or FUNCTION_BLOCK, using ADR 0013 common types and
ADR 0014 exclusions. Untyped constants and expressions reading inferred
PT/PV/ET/CV ports do not select; defaults remain TIME/INT, outputs never select,
and typed names provide an explicit choice. This POU-local inference rule is a
benchtop-plc restriction pending IEC edition verification (see #92).

| Feature                              | Status | Notes                                                                                                                                    |
| ------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `TON`, `TOF`, `TP`                   | Yes    | TIME PT/ET unless PT selects LTIME; negative PT is zero                                                                                  |
| `R_TRIG`, `F_TRIG`                   | Yes    | First call suppresses edges                                                                                                              |
| `CTU`, `CTD`, `CTUD`                 | Yes    | INT counters unless PV selects another type; saturation at type limits                                                                   |
| Typed counters                       | Yes    | CTU/CTD/CTUD with _INT, _DINT, _LINT, _UDINT, _ULINT; exact 64-bit counts                                                                |
| `SR`, `RS`                           | Yes    | Set dominant / reset dominant; Q1 initially FALSE                                                                                        |
| `TON_TIME`, `TOF_TIME`, `TP_TIME`    | Yes    | Same behavior as unsuffixed TIME timers                                                                                                  |
| `TON_LTIME`, `TOF_LTIME`, `TP_LTIME` | Yes    | LTIME PT/ET; nanoseconds from injected fractional-ms clock, limited by host resolution and floating-point precision; negative PT is zero |

## Configuration elements

| Feature                   | Status  | Notes                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONFIGURATION` in source | Partial | One optional source; implicit configuration for a single PROGRAM. PLCopen XML exchanges exact sources and reconstructs configurations for multiple tasks/event inputs; the web app edits the source and runs up to 16 cyclic/event tasks. ADR 0016, based on 3rd edition and secondary sources.                                  |
| `RESOURCE`                | Partial | Exactly one; arbitrary `ON` identifier is ignored. Configuration/resource globals with matching PROGRAM/FB externals.                                                                                                                                                                                                            |
| `TASK`                    | Partial | 1–16 non-preemptive tasks; priority 0–65535 (0 highest), then longest wait and declaration order. Exactly one of literal TIME/LTIME INTERVAL (10 ms–1 h, 10 ms steps) and SINGLE (non-constant BOOL global or supported %IX bit). GCD tick, rising-edge sampling, skipped activation overruns and per-task telemetry (ADR 0016). |
| Program instances         | Partial | 1–64, `WITH` required; same/different PROGRAM bodies, separate memory, declaration order. Named input/output connections to constants, globals and typed I/Q/M addresses; output connections cannot target I.                                                                                                                    |

## Implementation-dependent parameters

| Parameter                                 | Value                                                                                                                                                                                                                                                          |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Range and resolution of TIME              | Signed 32-bit milliseconds, −2147483648 to 2147483647; arithmetic wraps modulo 2^32; real scaling is exact then rounds once, nearest with ties to even; integer division truncates toward zero; out-of-range literals and external values are rejected         |
| Range and resolution of DATE              | Unsigned 32-bit seconds, whole days only: D#1970-01-01 to D#2106-02-07                                                                                                                                                                                         |
| Range and resolution of TOD               | Milliseconds since midnight, TOD#00:00:00 to TOD#23:59:59.999                                                                                                                                                                                                  |
| Range and resolution of DT                | Unsigned 32-bit seconds: DT#1970-01-01-00:00:00 to DT#2106-02-07-06:28:15                                                                                                                                                                                      |
| Long calendar ranges                      | Signed 64-bit nanoseconds; LDATE#1677-09-22 to LDATE#2262-04-11 (whole days); LTOD#00:00:00 to LTOD#23:59:59.999999999; LDT#1677-09-21-00:12:43.145224192 to LDT#2262-04-11-23:47:16.854775807                                                                 |
| Calendar out-of-range results             | TOD/LTOD wrap modulo one day, negative results count back from midnight; DATE/DT/LDATE/LDT fault with runtime.invalid-value. Coarser units floor toward negative infinity before range checking; literals and external values are rejected rather than wrapped |
| Calendar differences                      | DATE/TOD/DT differences wrap as signed 32-bit millisecond TIME; long forms wrap as signed 64-bit nanosecond LTIME. A 31-day DT difference gives T#-18d17h2m47s296ms; use LDT for longer differences                                                            |
| Calendar conversion extensions            | DATE_TO_LDATE, LDATE_TO_DATE, LDT_TO_LDATE and overloaded TO_ forms; exact day/time extraction and floor quantization                                                                                                                                          |
| Integer and bit-string ranges             | Signed SINT/INT/DINT/LINT: 8/16/32/64 bits; unsigned USINT/UINT/UDINT/ULINT and BYTE/WORD/DWORD/LWORD: 8/16/32/64 bits, respectively                                                                                                                           |
| Default scalar values                     | FALSE for BOOL; DATE/LDATE and DT/LDT default to 1970-01-01 (midnight for DT/LDT), TOD/LTOD to midnight; storage zero for all other types                                                                                                                      |
| Negative zero                             | Normalized to zero for every numeric type; a deviation from IEC 60559                                                                                                                                                                                          |
| Type of untyped literals                  | Exact constants typed by typed neighbors, otherwise destination, otherwise DINT, LINT or exactly representable LREAL; real defaults to LREAL (ADR 0013)                                                                                                        |
| Conversion of operands of different types | Set-based common type (ADR 0013): INT + UINT → DINT, DINT + REAL → LREAL, REAL + LREAL → LREAL, MAX(INT, UINT, REAL) → REAL; DINT + UDINT → LINT; LINT + ULINT and LINT + REAL have no common type                                                             |
| Reaction to integer overflow              | Computed typed results and out-of-range integer conversions wrap (ADR 0010); out-of-range literals/untyped constants are compile errors                                                                                                                        |
| Real → integer conversion                 | Nearest, ties to even, then wraps into the destination; vendor tie-breaking rules can differ                                                                                                                                                                   |
| TIME ↔ integer extensions                 | SINT/USINT/INT/UINT/DINT/UDINT/LINT/ULINT ↔ TIME use milliseconds; integer ↔ LTIME use nanoseconds, integer and TIME results wrap to their destination width                                                                                                   |
| Reaction to division by zero              | FAULT; `x MOD 0` is 0 (ADR 0010)                                                                                                                                                                                                                               |
| MUX selector out of range                 | FAULT with runtime.invalid-value; zero-based selector must identify one supplied value                                                                                                                                                                         |
| Negative shift/rotate count               | FAULT with runtime.invalid-value; nonnegative shifts at/above width yield zero, rotations reduce modulo width                                                                                                                                                  |
| BCD out-of-range results                  | Destination-width wrap; negative encoding inputs and invalid decimal digits fault with runtime.invalid-value                                                                                                                                                   |
| Reaction to non-finite REAL results       | FAULT (ADR 0010)                                                                                                                                                                                                                                               |
| Constant evaluation budget                | Decimal scales within ±10,000; larger powers are rejected as `type.invalid-constant` before allocation, including underflows                                                                                                                                   |
| Maximum loop iterations per scan          | 200,000, then FAULT (ADR 0010)                                                                                                                                                                                                                                 |
| Task cycle times                          | Explicit configuration: whole multiples of 10 ms, 10 ms–1 h; implicit configuration UI: 10, 20, 50 and 100 ms                                                                                                                                                  |
| Direct-address ranges                     | I/Q: 64 bytes; M: 1,024 bytes. X bits 0–7 per byte; B/W/D/L indices count 1/2/4/8-byte units; little-endian; non-finite REAL/LREAL reads fault                                                                                                                 |

Bit-string conversions follow the IEC binary-transfer rules (based on the 3rd
edition text). INT_TO_DWORD(-1) is 16#0000FFFF without sign extension;
WORD_TO_INT(16#FFFF) is -1. `<bits>_TO_BOOL` tests the rightmost bit, so
BYTE_TO_BOOL(2) is FALSE. REAL_TO_DWORD(1.0) is 16#3F800000;
DWORD_TO_REAL rejects NaN/infinity patterns and normalizes negative zero.
The compiler emits `type.portability` for REAL ↔ DWORD, LREAL ↔ LWORD and bit strings → BOOL:
some vendor runtimes convert the numeric value or test any nonzero bit instead.
External IR initial values, writes, forces and project initializer ranges are
validated; wrapping applies only to computed program results and conversions.

64-bit values remain exact across JSON IR, Worker messages, snapshots, monitor writes/forces
and PLCopen XML (`<LINT/>`, `<ULINT/>`, `<LWORD/>`, `<LTIME/>`). LTIME scales by real
operands using exact bigint fractions with one nearest-even rounding. LTIME_TO_TIME
truncates toward zero, then wraps. Integer-to-real and real-to-integer conversions
round nearest, ties to even; 64-bit integers require an explicit conversion to reals.
LREAL ↔ LWORD follows IEEE binary64 bit reinterpretation and reports the same
portability warning as REAL ↔ DWORD.

Calendar conversion semantics follow ADR 0013, based on the 3rd edition text and
secondary sources for the 4th edition long forms: DT → DATE/TOD/LTOD/LDT,
LDT → DT/DATE/TOD/LTOD, and TOD ↔ LTOD. LDT_TO_DT floors fractional seconds;
pre-epoch conversions to DATE or DT fault. DATE → LDATE, LDATE → DATE and
LDT → LDATE are extensions. Calendar values carry no time zone. Named calendar
functions support arithmetic, component construction/extraction and weekdays (#73).
A wall-clock function remains unsupported (ADR 0003).
PLCopen XML exchanges DATE/TOD/DT/LDATE/LTOD/LDT elementary elements; the monitor
reads, writes and forces their IEC literals with full stored precision.

Time/date component functions use YEAR/MONTH/DAY/HOUR/MINUTE/SECOND/MILLISECOND;
long splits discard sub-millisecond precision. Constructors reject impossible
components and out-of-range results, and DT floors to seconds. SPLIT functions
return TRUE on success. These signatures, including the long forms, follow the
issue #73 scope; the 4th edition text has not been independently checked.

## Differences from vendor runtimes

The compiler reports `type.portability` at the following calls, including their
resolved overloaded `TO_<B>` forms. These warnings allow loading and execution.

| Functions                                                        | benchtop-plc                                                                              | CODESYS / TwinCAT                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------------------------- |
| `REAL_TO_DWORD`, `DWORD_TO_REAL`                                 | Reinterpret the IEEE binary32 bit pattern; `REAL_TO_DWORD(1.0)` is `16#3F800000`          | Convert the numeric value          |
| `LREAL_TO_LWORD`, `LWORD_TO_LREAL`                               | Reinterpret the IEEE binary64 bit pattern; `LREAL_TO_LWORD(1.0)` is `16#3FF0000000000000` | Convert the numeric value          |
| `BYTE_TO_BOOL`, `WORD_TO_BOOL`, `DWORD_TO_BOOL`, `LWORD_TO_BOOL` | Return the rightmost bit; converting 2 returns FALSE                                      | Return TRUE for any non-zero value |

Real → integer conversion rounds to nearest, ties to even in benchtop-plc (for
example, `REAL_TO_INT(2.5)` is 2 and `REAL_TO_INT(3.5)` is 4). Vendor tie-breaking
can depend on the runtime or target hardware. This difference has no compiler
warning; check rounding expectations when porting a program. See
[ADR 0013](adr/0013-conversions-literals-and-operators.md).

## User function restrictions and standard checks

Multi-POU compilation accepts exactly one PROGRAM plus functions and function blocks, each in its own
text, with one case-insensitive namespace shared with all standard names.
PLCopen XML preserves ordered POU sources, including parseable
projects with semantic errors. The web editor shows the first program (or first
POU); the POU list adds functions and function blocks.

The following ADR 0014 choices follow the 3rd edition and secondary sources and
still need verification against the 4th edition: functions without a result type,
omitted-input defaults in formal user calls, and the direct/indirect recursion ban.
An empty user call uses all declared input defaults when there are no required in-outs. Non-formal calls support only
input-only functions, with every input supplied in declaration order; this is
Partial support of the standard's non-formal parameter list.

Project restrictions: functions cannot declare VAR_TEMP or FB instances; PROGRAM
cannot declare VAR_INPUT, VAR_OUTPUT or VAR_IN_OUT; direct addresses are allowed
in PROGRAM VAR and configuration/resource globals, and are forbidden in both
functions and function blocks.
EN/ENO remains deferred. CONSTANT is supported on VAR, VAR_GLOBAL and matching VAR_EXTERNAL, with elementary, string, character, alias, enum and subrange types and no AT. VAR_IN_OUT supports exact-type scalar/array/structure/reference caller variables, elements, members and dereferenced storage in formal calls only; instance members, bits, expressions and FB instances are rejected (restrictions).
Function locals, outputs and results are fresh per call. Operands and arguments
evaluate left to right; the 200,000-iteration limit is shared by all calls in a scan.

User FB inputs, outputs and VAR persist per instance; VAR_TEMP restarts from its
initializer each call (or each PROGRAM scan). Instances are allowed in VAR and configuration/resource globals;
acyclic nesting has no language depth limit. Inputs are readable/writable and
outputs readable from outside; internal members and nested instances are private.
Omitted FB inputs retain previous values. Standard and user FB `=>` bindings copy
outputs after the call. Load/cold reset initializes every nested instance, including
standard FB private state; STOP/RUN and FAULT preserve it. Every persistent scalar
member has a dotted monitor identity for snapshots, writes and forces. These
ADR 0014 access, restart and recursion choices still await 4th-edition verification.

### Character data restrictions

STRING/WSTRING capacities use `[n]` with an integer literal, 1–1,024 (default 80);
`STRING(n)` is rejected. Single-byte data uses ISO/IEC 8859-1 code units; wide data
uses UTF-16 code units, so a surrogate pair occupies two units. Physical line
breaks in literals are rejected. Constants exceeding a destination's capacity
are compile errors; dynamic stores truncate without a fault. Length does not
participate in type identity, including in-outs. CHAR → STRING and WCHAR → WSTRING
are the only implicit character conversions. Comparisons and MIN/MAX/LIMIT use
code-unit ordering with a prefix first; SEL/MUX use the ADR 0013 common type.
String functions use 1-based positions (INSERT permits zero), clamp lengths past
end, and fault on invalid positions/negative lengths. Results hold up to 1,024
code units before storage. String conversions use the monitor format and accept
all target literal prefixes, rejecting invalid or out-of-range text with
runtime.invalid-value. String functions/conversions execute at run time and are
not constant initializer expressions. Arrays and structures may contain strings. These decisions follow the 3rd edition
and secondary sources, pending 4th edition verification (ADR 0015).

## Array restrictions (ADR 0015)

Bounds must be constant integers fitting DINT. Each array has at most three
dimensions and 10,000 elements; a variable has at most 10,000 scalar leaves.
Arrays support elementary/string/enumeration/subrange, nested-array and structure elements.
Arrays support copied inputs/outputs, whole function results and in-out aliases.
Open dimensions (`ARRAY[*, ...]`) are allowed only directly in VAR_IN_OUT, with
all dimensions open and a matching actual rank/element type. LOWER_BOUND and
UPPER_BOUND return actual bounds as DINT; the dimension is a constant from 1 to
the rank. Constant arrays and whole-array comparisons remain unsupported.
Inline arrays of standard and user function block instances are supported in
PROGRAM/FB VAR, including indexed formal calls, output bindings, public port
access, independent state and cold reset. One timer/counter variant is selected
per declaration (ADR 0014/0015). Instances cannot be values, constants,
temporaries, function locals or parameters/results; instance array initializers,
named instance-array types and function blocks inside structures or nested value
arrays are unsupported. Monitor paths include standard elements and user members.
Whole-array MOVE/SEL/MUX for value arrays require equivalent bounds and element types,
including exact subrange limits; only string capacities are excluded from equivalence. Missing
initializer elements use their type defaults. These rules follow ADR 0015's
3rd-edition-based decisions, pending 4th edition verification.

## Structure restrictions (ADR 0015)

Structures support elementary/string/enumeration/subrange, nested structure and
array members, member defaults, partial nested initializers, arbitrary access
chains and whole-structure assignment/MOVE/SEL/MUX by name equivalence. Direct
and indirect containment cycles are compile errors. A variable has at most 10,000
scalar leaves. Function block members, aggregate constants, whole-structure
comparisons, OVERLAP and relative addresses remain unsupported. Copied
input/output parameters, in-out aliases and whole function results are supported. Scalar members support monitor writes/forces; PLCopen XML preserves
nested declarations and initial values. These decisions follow ADR 0015's
3rd-edition-based rules, pending 4th edition verification.

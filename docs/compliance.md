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

| Type                                            | Status | Notes                                                                      |
| ----------------------------------------------- | ------ | -------------------------------------------------------------------------- |
| BOOL                                            | Yes    |                                                                            |
| INT, DINT, UINT                                 | Yes    |                                                                            |
| SINT, USINT, UDINT                              | Yes    |                                                                            |
| LINT, ULINT                                     | Yes    | Canonical decimal strings, bigint arithmetic                               |
| BYTE, WORD, DWORD                               | Yes    | Unsigned bit patterns, formatted with full-width hexadecimal digits        |
| LWORD                                           | Yes    | 64-bit patterns, hexadecimal display and bit access through bit 63         |
| REAL, LREAL                                     | Yes    | REAL uses binary32 at every result; LREAL uses binary64                    |
| TIME                                            | Yes    | Signed 32-bit milliseconds (ADR 0012)                                      |
| LTIME                                           | Yes    | Signed 64-bit nanoseconds; LT#/LTIME#, including us/ns                     |
| DATE, TIME_OF_DAY, DATE_AND_TIME and long forms | Yes    | ADR 0012 ranges; TOD/DT/LTOD/LDT aliases; long forms use exact nanoseconds |
| CHAR, WCHAR, STRING, WSTRING                    | No     |                                                                            |

## Literals

| Feature                                          | Status  | Notes                                                                               |
| ------------------------------------------------ | ------- | ----------------------------------------------------------------------------------- |
| Integer literals, decimal, `2#` and `16#`        | Partial | Exact constants, typed by position (ADR 0013); checked against the resulting type   |
| Octal literals `8#`                              | Never   | Removed in the 4th edition (secondary source); rejected with `lex.malformed-number` |
| Real literals with exponent                      | Yes     |                                                                                     |
| Boolean literals `TRUE`, `FALSE`                 | Yes     |                                                                                     |
| Boolean literals `0`, `1`                        | Yes     | Integer constants in BOOL positions                                                 |
| Duration literals `T#`, `TIME#`, `LT#`, `LTIME#` | Yes     | Units d/h/m/s/ms, plus us/ns for LTIME; exact range checks precede TIME truncation  |
| Typed literals `<type>#<value>`                  | Partial | All supported elementary types; based integer and bit-string forms included         |
| Date and time-of-day literals                    | Yes     | All short and full prefixes; Gregorian dates, precision and ranges checked          |

## Derived types and variables

| Feature                                                                           | Status  | Notes                                                                                                |
| --------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `VAR` with initial values                                                         | Partial | Scalar constant expressions including conversion calls; other calls and FB initializers are rejected |
| Directly represented variables `%IX`, `%QX`                                       | Partial | BOOL only, at `%IX0.0`–`%IX0.7` and `%QX0.0`–`%QX0.7`                                                |
| `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT`, `VAR_TEMP`, `VAR_GLOBAL`, `VAR_EXTERNAL` | No      |                                                                                                      |
| `CONSTANT`, `RETAIN`, `NON_RETAIN`                                                | No      |                                                                                                      |
| `TYPE` declarations, enumerations, subranges                                      | No      |                                                                                                      |
| Arrays, structures, references                                                    | No      |                                                                                                      |

## Program organization units

| Feature                      | Status  | Notes                   |
| ---------------------------- | ------- | ----------------------- |
| `PROGRAM`                    | Partial | Exactly one per project |
| `FUNCTION`                   | No      |                         |
| `FUNCTION_BLOCK`             | No      |                         |
| Classes, methods, interfaces | No      |                         |
| Namespaces                   | No      |                         |

## Operators and statements (ST)

| Feature                                | Status | Notes                                                                                                                                                                                                                                                                |
| -------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `+ - * / MOD`, unary `+` and `-`       | Yes    | MOD accepts integers only; TIME/LTIME support duration addition/subtraction, scaling by a numeric right operand, and unary signs (minus rejects unsigned integers); calendar differences yield TIME/LTIME, TOD/DT ± duration select the narrowest matching signature |
| `**`                                   | No     |                                                                                                                                                                                                                                                                      |
| `AND`, `&`, `OR`, `XOR`, `NOT`         | Yes    | BOOL and BYTE/WORD/DWORD/LWORD only; operands use their common bit type; `&` is an alias for AND                                                                                                                                                                     |
| Comparisons                            | Yes    | Common type per ADR 0013; BOOL ordering is `FALSE < TRUE`; calendar values compare chronologically                                                                                                                                                                   |
| Bit access `x.n`                       | Yes    | BYTE/WORD/DWORD/LWORD variables; a constant index within the width, readable and writable                                                                                                                                                                            |
| Assignment `:=`                        | Yes    | Only ADR 0013 widening is implicit; narrowing needs an explicit conversion                                                                                                                                                                                           |
| FB call with named inputs              | Yes    |                                                                                                                                                                                                                                                                      |
| `IF`, `CASE`, `FOR`, `WHILE`, `REPEAT` | Yes    | CASE selectors and labels, and FOR variables and bounds, must be integers; CASE labels must be constant                                                                                                                                                              |
| `EXIT`, `RETURN`                       | Yes    |                                                                                                                                                                                                                                                                      |
| `CONTINUE`                             | No     |                                                                                                                                                                                                                                                                      |

## Standard functions

| Feature                                            | Status  | Notes                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ABS`, `MIN`, `MAX`, `LIMIT`, `SEL`                | Partial | ABS, MIN, MAX and LIMIT accept numeric types only; SEL also accepts BOOL, bit strings, TIME/LTIME and calendar values. Numeric MIN/MAX/LIMIT/SEL results use the set-based common type (ADR 0013); ABS preserves its argument type                                                                                                                    |
| Type conversion                                    | Partial | All supported numeric pairs; BOOL → integer; BOOL/bit-string pairs; integer ↔ bit string; REAL ↔ DWORD and LREAL ↔ LWORD bit reinterpretation; overloaded TO_ forms. TIME ↔ integer (milliseconds) and LTIME ↔ integer (nanoseconds) are extensions; TIME ↔ LTIME changes resolution; calendar conversion families and overloaded forms are supported |
| Numeric (`SQRT`, `LN`, `SIN`, …)                   | No      |                                                                                                                                                                                                                                                                                                                                                       |
| Arithmetic functions (`ADD`, `MUL`, …)             | No      |                                                                                                                                                                                                                                                                                                                                                       |
| Bit shift (`SHL`, `SHR`, `ROL`, `ROR`)             | No      |                                                                                                                                                                                                                                                                                                                                                       |
| Selection (`MUX`, `MOVE`) and comparison functions | No      |                                                                                                                                                                                                                                                                                                                                                       |
| Time and date functions                            | No      |                                                                                                                                                                                                                                                                                                                                                       |
| String functions                                   | No      |                                                                                                                                                                                                                                                                                                                                                       |

## Standard function blocks

| Feature                                           | Status | Notes                          |
| ------------------------------------------------- | ------ | ------------------------------ |
| `TON`, `TOF`, `TP`                                | Yes    | Negative PT is treated as T#0s |
| `R_TRIG`, `F_TRIG`                                | Yes    |                                |
| `CTU`, `CTD`                                      | Yes    | INT counters                   |
| `CTUD`, typed counters (`CTU_INT`, `CTU_DINT`, …) | No     |                                |
| `SR`, `RS`                                        | No     |                                |
| Typed timers (`TON_TIME`, `TON_LTIME`, …)         | No     |                                |

## Configuration elements

| Feature                                       | Status | Notes                                                  |
| --------------------------------------------- | ------ | ------------------------------------------------------ |
| `CONFIGURATION`, `RESOURCE`, `TASK` in source | No     | One cyclic task is implied; the cycle is set in the UI |

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
| Reaction to non-finite REAL results       | FAULT (ADR 0010)                                                                                                                                                                                                                                               |
| Constant evaluation budget                | Decimal scales within ±10,000; larger powers are rejected as `type.invalid-constant` before allocation, including underflows                                                                                                                                   |
| Maximum loop iterations per scan          | 200,000, then FAULT (ADR 0010)                                                                                                                                                                                                                                 |
| Task cycle times                          | 10, 20, 50 and 100 ms                                                                                                                                                                                                                                          |
| Direct-address ranges                     | `%IX0.0`–`%IX0.7`, `%QX0.0`–`%QX0.7`                                                                                                                                                                                                                           |

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
portability warning as REAL ↔ DWORD. LTIME timers remain unsupported (#74).

Calendar conversion semantics follow ADR 0013, based on the 3rd edition text and
secondary sources for the 4th edition long forms: DT → DATE/TOD/LTOD/LDT,
LDT → DT/DATE/TOD/LTOD, and TOD ↔ LTOD. LDT_TO_DT floors fractional seconds;
pre-epoch conversions to DATE or DT fault. DATE → LDATE, LDATE → DATE and
LDT → LDATE are extensions. Calendar values carry no time zone. Named calendar
functions and a wall-clock function remain unsupported (#73, ADR 0003).
PLCopen XML exchanges DATE/TOD/DT/LDATE/LTOD/LDT elementary elements; the monitor
reads, writes and forces their IEC literals with full stored precision.

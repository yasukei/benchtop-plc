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

| Type                                            | Status  | Notes                                                                                                                                                              |
| ----------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BOOL                                            | Yes     |                                                                                                                                                                    |
| INT, DINT, UINT                                 | Yes     |                                                                                                                                                                    |
| SINT, USINT, UDINT                              | No      |                                                                                                                                                                    |
| LINT, ULINT                                     | No      |                                                                                                                                                                    |
| BYTE, WORD, DWORD, LWORD                        | No      |                                                                                                                                                                    |
| REAL, LREAL                                     | Partial | REAL uses binary32 and LREAL stores binary64, but binary arithmetic and MIN/MAX/LIMIT/SEL with multiple numeric value arguments involving either type produce REAL |
| TIME                                            | Partial | Range not yet enforced (#24)                                                                                                                                       |
| LTIME                                           | No      |                                                                                                                                                                    |
| DATE, TIME_OF_DAY, DATE_AND_TIME and long forms | No      |                                                                                                                                                                    |
| CHAR, WCHAR, STRING, WSTRING                    | No      |                                                                                                                                                                    |

## Literals

| Feature                                   | Status  | Notes                                                                                    |
| ----------------------------------------- | ------- | ---------------------------------------------------------------------------------------- |
| Integer literals, decimal, `2#` and `16#` | Partial | Must fit signed DINT, including when assigned to another type; `-2147483648` is accepted |
| Octal literals `8#`                       | Yes     | Removed in the 4th edition (secondary source); to be rejected (ADR 0013)                 |
| Real literals with exponent               | Yes     |                                                                                          |
| Boolean literals `TRUE`, `FALSE`          | Yes     |                                                                                          |
| Boolean literals `0`, `1`                 | No      |                                                                                          |
| Duration literals `T#`, `TIME#`           | Yes     | Units d, h, m, s and ms; fractional milliseconds truncate toward zero                    |
| Typed literals `<type>#<value>`           | No      |                                                                                          |
| Date and time-of-day literals             | No      |                                                                                          |

## Derived types and variables

| Feature                                                                           | Status  | Notes                                                                             |
| --------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------- |
| `VAR` with initial values                                                         | Partial | Scalar constant expressions only; function calls and FB initializers are rejected |
| Directly represented variables `%IX`, `%QX`                                       | Partial | BOOL only, at `%IX0.0`–`%IX0.7` and `%QX0.0`–`%QX0.7`                             |
| `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT`, `VAR_TEMP`, `VAR_GLOBAL`, `VAR_EXTERNAL` | No      |                                                                                   |
| `CONSTANT`, `RETAIN`, `NON_RETAIN`                                                | No      |                                                                                   |
| `TYPE` declarations, enumerations, subranges                                      | No      |                                                                                   |
| Arrays, structures, references                                                    | No      |                                                                                   |

## Program organization units

| Feature                      | Status  | Notes                   |
| ---------------------------- | ------- | ----------------------- |
| `PROGRAM`                    | Partial | Exactly one per project |
| `FUNCTION`                   | No      |                         |
| `FUNCTION_BLOCK`             | No      |                         |
| Classes, methods, interfaces | No      |                         |
| Namespaces                   | No      |                         |

## Operators and statements (ST)

| Feature                                | Status  | Notes                                                                                                                        |
| -------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `+ - * / MOD`, unary `+` and `-`       | Yes     | MOD accepts integers only; TIME supports addition/subtraction with TIME, scaling by a numeric right operand, and unary signs |
| `**`                                   | No      |                                                                                                                              |
| `AND`, `&`, `OR`, `XOR`, `NOT`         | Yes     | BOOL and integers; `&` is an alias for AND. Integer operands are an extension                                                |
| Comparisons                            | Partial | `<`, `>`, `<=`, `>=` do not accept BOOL                                                                                      |
| Bit access `x.n`                       | No      |                                                                                                                              |
| Assignment `:=`                        | Yes     | Integer assignments may narrow and wrap; integer → real and REAL ↔ LREAL assignments are implicit                            |
| FB call with named inputs              | Yes     |                                                                                                                              |
| `IF`, `CASE`, `FOR`, `WHILE`, `REPEAT` | Yes     | CASE selectors and labels, and FOR variables and bounds, must be integers; CASE labels must be constant                      |
| `EXIT`, `RETURN`                       | Yes     |                                                                                                                              |
| `CONTINUE`                             | No      |                                                                                                                              |

## Standard functions

| Feature                                            | Status  | Notes                                                                                                                                                                                                |
| -------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ABS`, `MIN`, `MAX`, `LIMIT`, `SEL`                | Partial | ABS, MIN, MAX and LIMIT accept numeric types only; SEL also accepts matching BOOL or TIME values. Numeric MIN/MAX/LIMIT/SEL results follow the promotion rule below; ABS preserves its argument type |
| Type conversion                                    | Partial | `REAL_TO_INT`, `INT_TO_REAL`, `TIME_TO_INT`, `INT_TO_TIME`, `BOOL_TO_INT` only, with exact source-type arguments. TIME ↔ INT conversions in milliseconds are extensions                              |
| Numeric (`SQRT`, `LN`, `SIN`, …)                   | No      |                                                                                                                                                                                                      |
| Arithmetic functions (`ADD`, `MUL`, …)             | No      |                                                                                                                                                                                                      |
| Bit shift (`SHL`, `SHR`, `ROL`, `ROR`)             | No      |                                                                                                                                                                                                      |
| Selection (`MUX`, `MOVE`) and comparison functions | No      |                                                                                                                                                                                                      |
| Time and date functions                            | No      |                                                                                                                                                                                                      |
| String functions                                   | No      |                                                                                                                                                                                                      |

## Standard function blocks

| Feature                                           | Status | Notes        |
| ------------------------------------------------- | ------ | ------------ |
| `TON`, `TOF`, `TP`                                | Yes    |              |
| `R_TRIG`, `F_TRIG`                                | Yes    |              |
| `CTU`, `CTD`                                      | Yes    | INT counters |
| `CTUD`, typed counters (`CTU_INT`, `CTU_DINT`, …) | No     |              |
| `SR`, `RS`                                        | No     |              |
| Typed timers (`TON_TIME`, `TON_LTIME`, …)         | No     |              |

## Configuration elements

| Feature                                       | Status | Notes                                                  |
| --------------------------------------------- | ------ | ------------------------------------------------------ |
| `CONFIGURATION`, `RESOURCE`, `TASK` in source | No     | One cyclic task is implied; the cycle is set in the UI |

## Implementation-dependent parameters

| Parameter                           | Value                                                                                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Range and resolution of TIME        | Integer milliseconds in a JavaScript number; intended range not yet enforced (#24); fractional results truncate toward zero                                                                                 |
| Range of INT, DINT and UINT         | Signed 16-bit, signed 32-bit and unsigned 16-bit, respectively                                                                                                                                              |
| Default scalar values               | FALSE for BOOL, zero for the other supported types                                                                                                                                                          |
| Negative zero                       | Normalized to zero for every numeric type; a deviation from IEC 60559                                                                                                                                       |
| Integer literal typing              | INT through magnitude 32767, otherwise DINT; destination does not supply the type                                                                                                                           |
| Numeric promotion                   | Binary numeric operators and MIN/MAX/LIMIT/SEL numeric value arguments: REAL if any value is REAL/LREAL; otherwise DINT if any is DINT; otherwise INT. Two LREAL values give REAL; two UINT values give INT |
| Reaction to integer overflow        | Wraps (ADR 0010), including narrowing assignments and initializers                                                                                                                                          |
| REAL_TO_INT rounding                | Nearest, ties to even, then wraps into INT; vendor tie-breaking rules can differ                                                                                                                            |
| Reaction to division by zero        | FAULT; `x MOD 0` is 0 (ADR 0010)                                                                                                                                                                            |
| Reaction to non-finite REAL results | FAULT (ADR 0010)                                                                                                                                                                                            |
| Maximum loop iterations per scan    | 200,000, then FAULT (ADR 0010)                                                                                                                                                                              |
| Task cycle times                    | 10, 20, 50 and 100 ms                                                                                                                                                                                       |
| Direct-address ranges               | `%IX0.0`–`%IX0.7`, `%QX0.0`–`%QX0.7`                                                                                                                                                                        |

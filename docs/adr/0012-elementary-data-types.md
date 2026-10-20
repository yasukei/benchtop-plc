# 0012. Elementary data types, ranges and overflow

- Status: Accepted
- Date: 2026-10-20
- Related: [0002](0002-tree-shaped-ir-as-plain-data.md), [0003](0003-injected-clock.md),
  [0010](0010-operating-states-restarts-and-runtime-errors.md)

## Context

Milestone 1 supports seven elementary types with simplified rules. TIME is an integer
number of milliseconds with no defined range, so constants far outside any useful range
compile without a diagnostic (#24).

Milestone 3 adds the remaining elementary types of IEC 61131-3 (4th edition), except the
character and string types, which come with derived types later. The standard fixes
LTIME, LDATE, LTOD and LDT as signed 64-bit counts of nanoseconds. It leaves the range
and precision of TIME, DATE, TOD and DT, the default values of DATE and DT, and the
reaction to out-of-range results to the implementer, who must document them. Values
must remain plain JSON data in the IR and in UI–runtime messages (ADR 0002), but a
JavaScript number cannot hold every 64-bit integer exactly.

The 4th edition text was not available when this ADR was written. Where the decision
depends on the standard's details, it follows the 3rd edition text and secondary
sources on the changes in the 4th edition; `docs/compliance.md` says so where it
matters. ADR 0013 builds on this ADR with conversions, literal typing and operators.

## Decision

### Types, ranges and defaults

| Type | Meaning | Range | Default |
| --- | --- | --- | --- |
| BOOL | Boolean | FALSE, TRUE | FALSE |
| SINT, INT, DINT, LINT | Signed integer, 8/16/32/64 bits | −2^(n−1) to 2^(n−1) − 1 | 0 |
| USINT, UINT, UDINT, ULINT | Unsigned integer, 8/16/32/64 bits | 0 to 2^n − 1 | 0 |
| BYTE, WORD, DWORD, LWORD | Bit string, 8/16/32/64 bits | 0 to 2^n − 1 | 16#0 |
| REAL, LREAL | IEEE 754 binary32 / binary64 | Finite values only | 0.0 |
| TIME | Signed 32-bit count of milliseconds | T#-24d20h31m23s648ms to T#24d20h31m23s647ms | T#0s |
| LTIME | Signed 64-bit count of nanoseconds | LTIME#-106751d23h47m16s854ms775us808ns to LTIME#106751d23h47m16s854ms775us807ns | LTIME#0s |
| DATE | Unsigned 32-bit count of seconds since 1970-01-01, a multiple of 86,400 | D#1970-01-01 to D#2106-02-07 | D#1970-01-01 |
| TIME_OF_DAY (TOD) | Unsigned 32-bit count of milliseconds since midnight | TOD#00:00:00 to TOD#23:59:59.999 | TOD#00:00:00 |
| DATE_AND_TIME (DT) | Unsigned 32-bit count of seconds since 1970-01-01-00:00:00 | DT#1970-01-01-00:00:00 to DT#2106-02-07-06:28:15 | DT#1970-01-01-00:00:00 |
| LDATE | Signed 64-bit count of nanoseconds since 1970-01-01, a multiple of 86,400 × 10^9 | LDATE#1677-09-22 to LDATE#2262-04-11 | LDATE#1970-01-01 |
| LTIME_OF_DAY (LTOD) | Signed 64-bit count of nanoseconds since midnight | LTOD#00:00:00 to LTOD#23:59:59.999999999 | LTOD#00:00:00 |
| LDATE_AND_TIME (LDT) | Signed 64-bit count of nanoseconds since 1970-01-01-00:00:00 | LDT#1677-09-21-00:12:43.145224192 to LDT#2262-04-11-23:47:16.854775807 | LDT#1970-01-01-00:00:00 |

Date and time-of-day values have no time zone. The runtime still never reads the
wall clock (ADR 0003); a calendar clock is a later decision.

### Representation as data

- BOOL is a `boolean`. Types of up to 32 bits, REAL and LREAL are a `number`.
- The 64-bit types (LINT, ULINT, LWORD, LTIME, LDATE, LTOD, LDT) are a canonical decimal
  `string` in `ValueByType`, the IR, UI–runtime messages and anything persisted, so all
  of them stay JSON (ADR 0002). Canonical means: an optional `-`, no `+`, no leading
  zeros, no `-0`, no whitespace, and within the type's range. `BigInt()` alone is not a
  check (`BigInt(" 12")` and `BigInt("0x10")` succeed). The compiler's constant
  evaluation and the runtime's memory and arithmetic use `bigint` and convert at their
  boundaries.
- A value is valid only if it is in its type's range and meets the type's invariant.
  Unsigned and bit-string values are in 0 to 2^n − 1, so a DWORD is never negative
  (normalize JavaScript's signed bitwise results with `>>> 0`). DATE and LDATE are whole
  days, and TOD and LTOD are less than one day.
- Numbers never hold −0: coercion turns −0 into 0 for every numeric type, including REAL
  and LREAL, because JSON cannot carry −0. This deviates from IEC 60559.
- Every REAL result, including an intermediate result that is widened to LREAL later,
  is rounded to binary32 (`Math.fround`).
- `formatValue` prints IEC literal syntax: decimal for integers, `16#` with the full
  width of digits for bit strings (`16#00FF` for a WORD), `T#`/`LTIME#` for durations,
  `D#`, `TOD#`, `DT#` and their long forms for dates and times of day. REAL and LREAL
  print the shortest decimal that converts back to the same binary32 or binary64 value.
  Traces, snapshots and the variable monitor rely on this format.

### Values from outside the program

Initial values in the IR, values in write and force messages, and values in an
imported project are checked, by the runtime and the project codec as well as the UI.
A value that is not canonical, out of range or breaks its type's invariant is rejected
with a diagnostic; it is never wrapped or normalized. Wrap-around applies only to
results that the program computes.

### Constants

- A literal, initializer or CASE label whose value does not fit its type is a
  compile-time error (`type.invalid-constant`) at its span, for example `T#30d` or
  `x : INT := 40000;`. Untyped constants are evaluated exactly before they get a type
  (ADR 0013), so `x : INT := 30000 + 30000;` is an error as well.
- Operations on typed constants give the same result as at run time:
  `INT#32767 + INT#1` is `INT#-32768` and `TOD#23:00:00 + T#2h` is `TOD#01:00:00`.
  Where the run time would fault (division by zero, a non-finite REAL, a date outside
  its range), the constant expression is a compile-time error (`type.invalid-constant`)
  at its span instead.

### Results out of range at run time

The reaction depends on what the type measures:

| Kind | Types | Result outside the range |
| --- | --- | --- |
| Numbers and durations | Integers, bit strings, TIME, LTIME | Wraps modulo 2^n into the range, as ADR 0010 decided for integers |
| Times of day | TOD, LTOD | Wraps modulo one day; a negative result counts back from midnight: `TOD#00:00:01 - T#2s` is `TOD#23:59:59` |
| Points in time | DATE, DT, LDATE, LDT | Faults with `runtime.invalid-value` |
| Reals | REAL, LREAL | A non-finite result faults (ADR 0010) |

- The results of conversion functions follow the same rule for their destination type:
  `DINT_TO_INT(40000)` is −25536, `LDATE_TO_DATE(LDATE#1969-12-31)` faults.
- A difference of two dates or times is a duration and wraps like one. Thirty-one days,
  `DT#2026-02-01-00:00:00 - DT#2026-01-01-00:00:00`, exceed TIME and give
  `T#-18d17h2m47s296ms`. Programs that need longer differences use LDT and LTIME.
- Division by zero still faults, and `x MOD 0` is still 0 (ADR 0010).

### Loss of resolution

A result that is finer than its destination type is first computed exactly, then
quantized once, and then checked against the range:

- A value computed from a real rounds to nearest, ties to even: `T#3ms * 0.5` is `T#2ms`.
- A duration in a coarser unit truncates toward zero:
  `LTIME_TO_TIME(LTIME#-1500us)` is `T#-1ms`.
- A date or time of day in a coarser unit rounds toward negative infinity, so it never
  moves later: `LDT_TO_DT(LDT#1970-01-01-00:00:01.999)` is `DT#1970-01-01-00:00:01`, and
  a DT plus `T#500ms` is the same DT.
- 64-bit values are not converted to a JavaScript number for arithmetic; for example
  LTIME * LREAL multiplies the exact values as `bigint` and rounds once.

### Timers

Standard timers treat a negative PT as T#0s.

## Consequences

- Programs written for Milestone 1 can stop compiling where literals are out of range,
  for example TIME literals beyond about 24 days. The changelog lists these changes.
- An expression gives the same result whether its operands are constants or variables;
  only the values written in the source are checked against their types.
- Every kind of value keeps valid values: integers and durations wrap like hardware
  registers, a time of day stays within the day, and a date never jumps across its
  range. The price is a run-time fault for dates that a program can only avoid by
  checking ranges.
- Differences of DT values beyond about 24 days wrap; LDT and LTIME avoid that.
- 64-bit values cost a string ↔ bigint conversion at the runtime boundary and a second
  code path for arithmetic.
- TIME matches the common 32-bit PLC range; programs that need longer durations or
  sub-millisecond resolution use LTIME.

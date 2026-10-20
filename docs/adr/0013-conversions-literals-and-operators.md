# 0013. Conversions, literal typing and operators

- Status: Accepted
- Date: 2026-10-20
- Related: [0004](0004-diagnostics-as-codes-with-arguments.md),
  [0010](0010-operating-states-restarts-and-runtime-errors.md),
  [0012](0012-elementary-data-types.md)

## Context

Milestone 1 lets any integer be assigned to any other integer, gives REAL for
arithmetic that mixes REAL and LREAL, types integer literals INT or DINT by magnitude
and provides a few conversion functions with ad hoc semantics. ADR 0012 defines the
elementary types, their ranges and what happens to results outside them. This ADR
defines how values of different types meet.

The standard defines the implicit conversions and the conversion functions with their
semantics (binary transfer for bit strings). It leaves to the implementer how operands
of different types are converted to each other and how untyped literals get their
type. Some vendor runtimes differ from the standard's conversion functions in ways that
still compile. As ADR 0012, this ADR follows the 3rd edition text and secondary sources
on the changes in the 4th edition; `docs/compliance.md` says so where it matters.

## Decision

### Implicit conversion

A value converts implicitly only along these chains, and along any path made of them:

- SINT → INT → DINT → LINT and USINT → UINT → UDINT → ULINT;
- USINT → INT, UINT → DINT, UDINT → LINT;
- integers of up to 16 bits → REAL; integers of up to 32 bits and REAL → LREAL;
- BOOL → BYTE → WORD → DWORD → LWORD, filling with zeros;
- TIME → LTIME, DATE → LDATE, TOD → LTOD, DT → LDT.

Every other conversion needs a conversion function: all narrowing, integer ↔ bit
string, BOOL → number, 64-bit integers → LREAL and 32-bit integers → REAL. The
diagnostic carries the existing `explicit-conversion` hint.

### Common type

Where operands, or the arguments of one generic parameter group of a function, must
have one type (arithmetic, comparison and bitwise operators; `MAX`, `MIN`, `LIMIT`,
`SEL`, `MUX`, `ADD`, `MUL` and the like), the typed ones convert to their common type:

1. The candidates are the types that every operand converts to implicitly, including
   its own type.
2. The common type is the candidate that converts implicitly to every other candidate.
3. If there is none and all operands are integers, it is the integer candidate that
   converts implicitly to every other integer candidate.
4. Otherwise there is no common type, which is a compile error.

| Operand types | Common type |
| --- | --- |
| INT, UINT | DINT (rule 3; REAL is also a candidate) |
| SINT, USINT | INT |
| DINT, UDINT | LINT (rule 3; LREAL is also a candidate) |
| INT, REAL | REAL |
| DINT, REAL | LREAL |
| INT, UINT, REAL | REAL |
| LINT, ULINT | none |
| LINT, REAL | none |
| BOOL, BYTE | BYTE |
| TIME, LTIME | LTIME |

The rule works on the set of operand types, so the result does not depend on their
order.

### Literals

- Typed literals `<type>#<value>` exist for every elementary type, for example
  `INT#-5`, `UINT#16#FF`, `BYTE#2#1010_0101`, `REAL#1.5`, `BOOL#1`. Duration, date and
  time-of-day literals keep their own prefixes (`T#`, `LT#`, `D#`, `LD#`, `TOD#`,
  `LTOD#`, `DT#`, `LDT#`, and the long spellings).
- Integer literals are decimal, `2#` or `16#`. Octal `8#` literals are rejected
  (`lex.malformed-number`); the 4th edition removed them.
- An untyped literal, or an expression made only of untyped literals, parentheses,
  unary minus and arithmetic operators, is an *untyped constant*. It is evaluated
  exactly: with unbounded integers (division toward zero) when all its literals are
  integers, otherwise with exact fractions. Then its position gives it a type:
  1. As an operand or generic argument next to typed ones, it takes their common
     type, if that type can hold its kind of value: an integer constant can become any
     integer, bit-string or real type, and BOOL for 0 and 1; a real constant can become
     REAL or LREAL. `i + 40000` with `i : INT` makes 40000 an INT, which is an error.
     `MAX(1, x_usint, 300)` makes 300 a USINT, which is an error.
  2. As the whole value of an assignment, initializer, FB input or non-generic
     function parameter, as a CASE label, or as the end value or step of a FOR loop
     (which take the control variable's type), it takes the destination type.
     `b : BYTE := 200;`, `x : INT := 1 + 2;`, `done : BOOL := 1;` and, with `i : INT`,
     `FOR i := 5 TO 1 BY -2 DO` compile. With `r : LREAL`, `r := 1 / 2;` evaluates the
     integer 0 and assigns 0.0.
  3. Otherwise it takes the first of DINT, LINT and LREAL that the position accepts and
     that holds the value exactly; a real constant takes LREAL. This covers positions
     whose type does not depend on the other operands: the factor in `t * 2` for a
     TIME `t`, a shift count, the exponent of `**`. In `2 ** 10` the base becomes
     LREAL. `TO_INT(300)` converts a DINT. `i + 1.5` with `i : INT` makes 1.5 an LREAL,
     so the sum is LREAL.
- A value that does not fit the type the constant gets is a compile-time error
  (`type.invalid-constant`) at the constant. A real value is rounded once, directly from
  its exact value, to the nearest REAL or LREAL, ties to even. Typed real literals are
  rounded the same way. So `REAL#1.000000178813934326171874999` is the binary32 value
  next above 1.0, although rounding to binary64 first would give the one after it.
- A type never flows from an assignment target into a larger expression: in
  `r := i + 40000;` the literal is typed by `i`, not by `r`.

### Operators

| Operator | Operands | Result |
| --- | --- | --- |
| `+`, `-`, `*`, `/` | ANY_NUM, converted to their common type | Common type |
| `MOD` | ANY_INT, converted to their common type | Common type |
| `**` (`EXPT`) | Base ANY_REAL, exponent ANY_NUM, not converted to each other | Type of the base |
| Unary `-` | Signed integers, reals, TIME and LTIME; unsigned is an error | Operand type |
| `AND`, `&`, `OR`, `XOR`, `NOT` | BOOL and ANY_BIT, converted to their common type | Common type |
| `=`, `<>`, `<`, `>`, `<=`, `>=` | ANY_ELEMENTARY, converted to their common type | BOOL |

- Ordering is numeric for numbers and bit strings, chronological for durations, dates
  and times of day, and `FALSE < TRUE` for BOOL.
- Durations, dates and times of day: TIME ± TIME → TIME; TIME * ANY_NUM and
  TIME / ANY_NUM → TIME; TOD ± TIME → TOD; DT ± TIME → DT; TOD − TOD, DT − DT and
  DATE − DATE → TIME; likewise for the long forms with LTIME. Operands convert
  implicitly to the narrowest matching signature, so TOD + LTIME is LTOD + LTIME → LTOD.
  TIME / ANY_INT truncates toward zero like integer division, and TIME * or / ANY_REAL
  rounds as ADR 0012 says; likewise for LTIME.
- Integer `/` truncates toward zero. `MOD` takes the sign of the dividend
  (`-7 MOD 2` is −1). Division by zero faults and `x MOD 0` is 0 (ADR 0010).
  `DINT#-2147483648 / -1` wraps to `DINT#-2147483648` like any other integer result.
- `SHL`, `SHR`, `ROL` and `ROR` take an ANY_BIT value and an ANY_INT count that is not
  converted to the value's type; the result has the value's type.
- Bit access `x.n` reads or writes bit n of an ANY_BIT variable; n must be a constant
  within the type's width.

### Explicit conversions

The forms are `<A>_TO_<B>` and the overloaded `TO_<B>`, plus `<A>_TRUNC_<B>` and
`TRUNC_<B>`, which truncate a real toward zero. The untyped `TRUNC(x)` is rejected; the
4th edition removed it. A conversion computes its exact result, quantizes it as ADR 0012
says, and then applies the destination type's out-of-range rule from ADR 0012.

| Family | Functions | Semantics |
| --- | --- | --- |
| Numbers | Every ordered pair of distinct integer and real types | Integer → integer keeps the value, then wraps: `DINT_TO_INT(40000)` is −25536. Integer → real and LREAL → REAL round to nearest, ties to even; a result beyond REAL's range faults. Real → integer rounds to nearest, ties to even, then wraps: `REAL_TO_INT(2.5)` is 2, `REAL_TO_INT(-2.5)` is −2, `REAL_TO_INT(40000.0)` is −25536. |
| Bit strings | Every ordered pair of BOOL, BYTE, WORD, DWORD and LWORD | A narrower result keeps the rightmost bits; a wider one is filled with zeros. `<bits>_TO_BOOL` is the rightmost bit: `BYTE_TO_BOOL(2)` is FALSE. `BOOL_TO_<bits>` is 0 or 1. |
| Bit strings and numbers | Integer ↔ BYTE, WORD, DWORD, LWORD; `BOOL_TO_<integer>`; REAL ↔ DWORD; LREAL ↔ LWORD | Binary transfer of the two's-complement bit pattern: the rightmost bits are kept, the rest is filled with zeros, with no sign extension. `INT_TO_DWORD(-1)` is `16#0000FFFF`, `WORD_TO_INT(16#FFFF)` is −1. `BOOL_TO_<integer>` is 0 or 1. REAL ↔ DWORD and LREAL ↔ LWORD reinterpret the IEEE 754 bit pattern: `REAL_TO_DWORD(1.0)` is `16#3F800000`. A pattern of NaN or infinity faults with `runtime.invalid-value`; the pattern of −0.0 gives 0.0. |
| Dates and times | `LTIME_TO_TIME`, `TIME_TO_LTIME`, `LDT_TO_DT`, `LDT_TO_DATE`, `LDT_TO_LTOD`, `LDT_TO_TOD`, `DT_TO_LDT`, `DT_TO_DATE`, `DT_TO_LTOD`, `DT_TO_TOD`, `LTOD_TO_TOD`, `TOD_TO_LTOD` | `_TO_DATE` gives the day and `_TO_TOD`/`_TO_LTOD` the time since midnight. A coarser unit is quantized as ADR 0012 says: durations toward zero, dates and times of day toward negative infinity. |

These are not in the standard and `docs/compliance.md` lists them as extensions:

- `<integer>_TO_TIME` and `TIME_TO_<integer>` in milliseconds, `<integer>_TO_LTIME` and
  `LTIME_TO_<integer>` in nanoseconds, wrapping as above: `TIME_TO_INT(T#40s)` is
  −25536. They keep Milestone 1's `TIME_TO_INT` and `INT_TO_TIME`, and major vendor
  runtimes offer them.
- `DATE_TO_LDATE`, `LDATE_TO_DATE` and `LDT_TO_LDATE`, so that every pair of a short and
  a long date type has a conversion.

Other conversions, for example `INT_TO_BOOL`, `REAL_TO_BOOL`, `BYTE_TO_REAL` or
`TIME_TO_REAL`, do not exist.

### Differences from vendor runtimes

Some calls compile both in benchtop-plc and in major vendor runtimes but give different
results: `REAL_TO_DWORD`, `DWORD_TO_REAL`, `LREAL_TO_LWORD` and `LWORD_TO_LREAL`
(CODESYS and TwinCAT convert the numeric value) and `<bits>_TO_BOOL` (they return TRUE
for any non-zero value). The compiler is to report a warning (`type.portability`) at
such calls. Differences that cannot be detected statically, such as the rounding of
ties in real → integer conversion, are listed in `docs/compliance.md`.

## Consequences

- Programs written for Milestone 1 can stop compiling: narrowing assignments, bitwise
  operators on integers, constants that do not fit, octal literals and the untyped
  `TRUNC` need fixes. The changelog lists these breaking changes.
- Literal typing is local. `r := i + 40000;` is an error although `r` could hold the
  sum, and `1 / 2` is integer division; typed literals or conversions say otherwise.
- One set-based rule decides every common type, independent of operand order, and the
  checker never chooses between incomparable candidates silently.
- Untyped constants need exact integer and fraction arithmetic in the compiler, so
  that every real constant is rounded only once.
- Bit-string conversions follow the standard's binary transfer, which differs from some
  vendor runtimes; the warning and the compliance table make the differences visible.

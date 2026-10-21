# Semantic checking

`check(ast)` accepts the `Program` returned by `parse(source)`. It returns either
`{ checked: CheckedProgram, diagnostics }` (warnings only) or `{ checked: null, diagnostics }`.
It collects semantic errors with source spans and never exposes a partially
checked program. Parsing remains separate; [`compile(source)`](compiler.md)
combines parsing, checking and IR lowering.

The checked result retains the original AST without modifying it, plus:

- `symbols`: `VariableSymbol` entries in declaration order, with the original
  identifier, type and coerced initial value (scalar defaults are FALSE/zero;
  FB initialization is null).
- `expressions`: AST expression object to result type and optional constant value.
- `references`: AST identifier object to variable index and optional FB port/index or bit index.
  Declaration names, assignment targets, reads, FOR variables, FB instances and
  named inputs all use the same symbol IDs.
- `functions`: AST function-call object to canonical standard-function opcode.

These Maps are compiler-local side tables keyed by AST identity. They are not
serialized or sent to the runtime. The lowering pass uses them to produce
the plain tree IR. Source spelling and spans stay in the AST.

## Rules

Names are matched by their parser-supplied upper-case keys, across all VAR blocks.
All declarations are collected before checking expressions. Initializers and CASE
labels may use constant expressions, including typed literals and conversion calls;
variable references, FB members and other function calls are not constants.

Implicit conversions follow [ADR 0013](adr/0013-conversions-literals-and-operators.md).
The supported paths are SINT → INT → DINT → LINT; USINT → UINT → UDINT → ULINT;
USINT → INT, UINT → DINT and UDINT → LINT; integers up to 16 bits → REAL; integers up to
32 bits and REAL → LREAL; and BOOL → BYTE → WORD → DWORD → LWORD; TIME → LTIME; DATE → LDATE, TOD → LTOD and DT → LDT.
64-bit integers never widen implicitly to REAL or LREAL. Every narrowing
conversion requires a conversion function; the diagnostic includes the localizable
`explicit-conversion` hint.
These rules apply to assignments, initializers, FB inputs, fixed function
parameters, CASE labels and FOR start/end/step values (the control variable's type).

Operators and generic function value arguments use one set-based common
type, independent of argument order: select a candidate all operands can widen to
that itself widens to all other candidates. If none exists and all operands are
integers, repeat that selection with only integer candidates. For example INT +
UINT is DINT, DINT + REAL is LREAL, REAL + LREAL is LREAL, and MAX(INT, UINT, REAL)
is REAL. Selection considers the full ADR 0012 type set, including types not yet
implemented. DINT + UDINT selects LINT; LINT + ULINT and LINT + REAL have no
common type. Incompatible types are errors. Unary minus accepts signed integers, reals
and TIME/LTIME, and rejects unsigned integers. All comparisons accept BOOL (`FALSE < TRUE`).
AND, &, OR, XOR and NOT accept BOOL and bit strings only. Operands widen to their
common bit type (TRUE AND BYTE#3 is BYTE#1). Comparisons order bit strings by their
unsigned numeric value. Bit access `x.n` reads or assigns a BOOL on a BYTE, WORD or
DWORD or LWORD variable; n is a decimal constant index, zero-based and less than its width.
An invalid index reports `type.invalid-bit-access`. Assignment changes only that bit.
TIME and LTIME support duration addition/subtraction and scaling with an independently
typed numeric factor. Mixed TIME/LTIME expressions use LTIME after converting milliseconds
to nanoseconds. LTIME literals accept us and ns in addition to d/h/m/s/ms.

Calendar declarations accept DATE, TOD/TIME_OF_DAY, DT/DATE_AND_TIME, LDATE,
LTOD/LTIME_OF_DAY and LDT/LDATE_AND_TIME. IR types use DATE, TOD, DT, LDATE, LTOD,
and LDT. Literals accept D#/DATE#, LD#/LDATE#, TOD#/TIME_OF_DAY#,
LTOD#/LTIME_OF_DAY#, DT#/DATE_AND_TIME# and LDT#/LDATE_AND_TIME#.
Calendar fields may be unpadded and contain underscore digit separators, including
fractional seconds (for example `D#2_026-1-5` or `LTOD#15:36:55.360_227_400`).
Formatting uses padded fields and omits separators. Invalid Gregorian dates, unsupported fractional precision and out-of-range literals
report `type.invalid-constant`.

DATE − DATE, TOD − TOD and DT − DT yield TIME; long or mixed short/long differences
yield LTIME. TOD ± TIME and DT ± TIME retain the left type; a long operand selects
the long signature (including TOD + LTIME → LTOD). DATE ± duration, addition of two
calendar values and unary calendar signs are rejected. Comparisons use chronological
order within each compatible calendar family. Typed constant operations have exactly
the runtime's wrap, floor and fault semantics.

### Literals and constants

Numeric literals without a type, and expressions containing only these literals,
parentheses, unary signs and arithmetic operators, are untyped constants. They
use unbounded integer arithmetic (division toward zero) when every literal is an
integer, otherwise exact fractions. They receive a type after evaluation:

1. From the common type of originally typed neighbors or generic arguments, if
   that type can hold the kind of constant (real constants need REAL/LREAL).
   Defaults chosen for other untyped constants do not influence this step.
2. From a typed destination when the whole value is untyped: assignment, initializer,
   FB input, fixed parameter, CASE label or FOR bound/step. Integer 0 and 1 also
   work in BOOL positions, including conditions.
3. Otherwise DINT for an integer in range, then LINT, then LREAL only if it holds
   that integer exactly; real constants default to LREAL.

The destination never supplies a type inside a larger typed expression:
`l := i + 40000` with `i : INT` rejects 40000 even if `l : LREAL`. Likewise,
`MAX(i, 1.5, 40000)` rejects 40000 as an INT constant; the fallback LREAL type of
1.5 does not widen it. `MAX(i, 1.5, DINT#40000)` is valid: the originally typed
arguments have common type DINT, and the final call has common type LREAL after
1.5 receives its default type.
`x : INT := 30000 + 30000` is invalid, while `x : INT := 1 + 2` is 3.
`l : LREAL := 1 / 2` is 0.0 because the arithmetic uses only integer literals.
Out-of-range constants report `type.invalid-constant` at the constant's span. Decimal scales
outside ±10,000 are also rejected with this diagnostic before constructing a
power of ten, keeping compilation responsive while editing or restoring source.
This is a compiler resource limit, including for values that would round to zero.

Typed literals cover BOOL, SINT, USINT, INT, UINT, DINT, UDINT, BYTE, WORD, DWORD,
REAL, LREAL, LINT, ULINT and LWORD, plus T#/TIME# and LT#/LTIME#.
Examples include `BOOL#1`, `INT#-5`, `UINT#16#FF` and `REAL#1.5`.
Untyped integers accept decimal, binary `2#` and hexadecimal `16#`; octal `8#`
reports `lex.malformed-number`. Every numeric literal retains its source text for
exact evaluation. Real constants round once directly from their exact decimal or
fraction value to binary32/64, nearest with ties to even, including subnormals.
`REAL#1.000000178813934326171874999` therefore prints as 1.0000001.

Operations on typed constants have runtime semantics: integer results wrap,
every REAL intermediate rounds to binary32, and LREAL keeps binary64 precision.
`INT#32767 + INT#1` is -32768. Runtime faults (division by zero or non-finite
results) become `type.invalid-constant`. Negative zero normalizes to zero.

## Standard signatures

The compiler consumes the shared core function/block descriptors. Port order follows
[core-contracts.md](core-contracts.md). Omitted FB inputs retain their values;
provided inputs must be unique, writable and assignable to their declared types.

| Function                                            | Arguments                                                                          | Result                               |
| --------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------ |
| ABS                                                 | ANY_NUM                                                                            | Argument type                        |
| SQRT, LN, LOG, EXP, SIN, COS, TAN, ASIN, ACOS, ATAN | ANY_REAL                                                                           | Argument type                        |
| ATAN2                                               | Two ANY_REAL values (y, x)                                                         | Common type                          |
| ADD, MUL                                            | Two or more ANY_NUM values                                                         | Common type                          |
| SUB, DIV                                            | Two ANY_NUM values                                                                 | Common type                          |
| MOD                                                 | Two ANY_INT values                                                                 | Common type                          |
| EXPT, `**`                                          | ANY_REAL base, independently typed ANY_NUM exponent                                | Base type                            |
| MOVE                                                | ANY_ELEMENTARY                                                                     | Argument type                        |
| SHL, SHR, ROL, ROR                                  | ANY_BIT value, independently typed ANY_INT count                                   | Value type                           |
| AND, OR, XOR                                        | Two or more ANY_BIT values                                                         | Common type                          |
| NOT                                                 | ANY_BIT                                                                            | Argument type                        |
| MIN, MAX                                            | Two or more ANY_ELEMENTARY values                                                  | Common type                          |
| LIMIT                                               | Three ANY_ELEMENTARY values (lower, input, upper)                                  | Common type                          |
| SEL                                                 | BOOL selector, two compatible ANY_ELEMENTARY values                                | Common type of values                |
| MUX                                                 | Independently typed ANY_INT selector, two or more compatible ANY_ELEMENTARY values | Common type of values                |
| GT, GE, EQ, LE, LT                                  | Two or more compatible ANY_ELEMENTARY values                                       | BOOL (all adjacent comparisons hold) |
| NE                                                  | Two compatible ANY_ELEMENTARY values                                               | BOOL                                 |
| `TRUNC_<B>`                                         | ANY_REAL                                                                           | Integer B                            |
| `<A>_TRUNC_<B>`                                     | One value assignable to real A                                                     | Integer B                            |
| `<A>_BCD_TO_<B>`                                    | One value assignable to bit string A                                               | Integer B                            |
| `<A>_TO_BCD_<B>`                                    | One value assignable to integer A                                                  | Bit string B                         |
| `<A>_TO_<B>`                                        | One value assignable to A                                                          | B                                    |
| `TO_<B>`                                            | One value from a supported conversion source family                                | B                                    |

ANY_NUM includes signed/unsigned integers and reals; ANY_INT includes all eight
integer types; ANY_REAL is REAL/LREAL; ANY_BIT includes BOOL and all bit strings.
ANY_ELEMENTARY includes all supported scalar types, including BOOL, durations and
calendar types. Generic groups use the set-based common type described above;
selectors, shift counts and exponents never participate in the value group.
An untyped integer in a real-only position (including the base of `2 ** 10`)
becomes LREAL. Typed integer bases require an explicit real conversion.
`**` binds more tightly than unary operators and multiplication (`-2 ** 2` is -4.0);
operators at the same precedence evaluate left to right, so `2 ** 3 ** 2` is 64.0.
Keyword function calls such as `AND(a, b)` and `MOD(a, b)` are accepted.
`NOT(expr)` retains the existing parse as unary NOT with a parenthesized operand,
so it remains valid in constant expressions.

Truncation discards the fractional part toward zero, then wraps to B. Unlike the
existing `_TO_` conversions, the new functions are not constant expressions and
cannot appear in initializers or CASE labels. `TRUNC(x)` is rejected (removed in
the 4th edition). BCD forms cover every integer/bit-string pair (excluding BOOL);
invalid digits fault at runtime. See [runtime.md](runtime.md) for edge behavior.

Numeric conversions cover every distinct ordered pair among the supported integers
and reals. BOOL_TO_<integer> returns 0 or 1. TIME ↔ integer conversions are extensions
in milliseconds. LTIME ↔ integer extensions use nanoseconds. TIME_TO_LTIME scales
by 1,000,000; LTIME_TO_TIME truncates nanoseconds toward zero to milliseconds, then
wraps to TIME. Overloaded TO_<type> selects from the argument's actual type;
identity inputs are accepted. Fixed source parameters accept implicit widening,
with untyped constants checked directly against that source type.

Integer conversions wrap; real → integer rounds nearest, ties to even, then wraps.
Integer → real and LREAL → REAL round nearest, ties to even. REAL overflow faults
at runtime and is rejected in a constant expression.

Conversions among BOOL/BYTE/WORD/DWORD/LWORD keep the rightmost bits and zero-fill wider
results; conversion to BOOL tests only bit zero. Integer ↔ bit-string conversions
transfer the source-width two's-complement pattern without sign extension:
INT_TO_DWORD(-1) is 16#0000FFFF, while WORD_TO_INT(16#FFFF) is -1.
REAL_TO_DWORD and DWORD_TO_REAL reinterpret IEEE binary32 bits; LREAL_TO_LWORD
and LWORD_TO_LREAL reinterpret binary64 bits. Integer-to-real conversion rounds
directly from the exact integer, including 64-bit sources. NaN and infinity
patterns fault, and the negative-zero pattern becomes positive zero.
These reinterpretations and bit strings → BOOL report a `type.portability` warning
because some vendor runtimes differ. Warnings preserve a successful checked result
and executable IR. BOOL → real, integer → BOOL, BYTE/WORD → real and TIME → real
conversions do not exist.

Diagnostics identify offending names, members, address tokens, expressions or
EXIT statements. The codes and argument shapes are in
[diagnostics.md](diagnostics.md). `type.case-label-not-constant`,
`type.invalid-constant` and `fb.duplicate-input` extend that catalog because the
existing codes could not represent those failures accurately.

Calendar conversions are DT_TO_DATE, DT_TO_TOD, DT_TO_LTOD, DT_TO_LDT,
LDT_TO_DT, LDT_TO_DATE, LDT_TO_TOD, LDT_TO_LTOD, TOD_TO_LTOD and LTOD_TO_TOD,
with overloaded TO_<destination> forms. DATE_TO_LDATE, LDATE_TO_DATE and
LDT_TO_LDATE are extensions. Date extraction floors to the start of the day;
time extraction is a nonnegative offset within the day, even before 1970.
Reducing resolution floors toward negative infinity. A calendar result outside the
destination range faults with `runtime.invalid-value`, or reports
`type.invalid-constant` in constant evaluation.

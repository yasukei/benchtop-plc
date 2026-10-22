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
- `userCalls`: resolved user function indices, supplied inputs in source order,
  output bindings and the optional result type.
- `result`: the function's synthetic local result symbol, when it has a result.
- `functionArguments`: AST function-call object to inputs in descriptor order, after
  resolving formal names. The original AST retains source order.

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
parameters, function and FB outputs, CASE labels and FOR start/end/step values (the control variable's type).

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

| Function                                            | Arguments                                                                            | Result                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------ |
| ABS                                                 | ANY_NUM                                                                              | Argument type                        |
| SQRT, LN, LOG, EXP, SIN, COS, TAN, ASIN, ACOS, ATAN | ANY_REAL                                                                             | Argument type                        |
| ATAN2                                               | Two ANY_REAL values (y, x)                                                           | Common type                          |
| ADD, MUL                                            | Two or more ANY_NUM values                                                           | Common type                          |
| SUB, DIV                                            | Two ANY_NUM values                                                                   | Common type                          |
| MOD                                                 | Two ANY_INT values                                                                   | Common type                          |
| EXPT, `**`                                          | ANY_REAL base, independently typed ANY_NUM exponent                                  | Base type                            |
| MOVE                                                | ANY_ELEMENTARY                                                                       | Argument type                        |
| SHL, SHR, ROL, ROR                                  | ANY_BIT value, independently typed ANY_INT count                                     | Value type                           |
| AND, OR, XOR                                        | Two or more ANY_BIT values                                                           | Common type                          |
| NOT                                                 | ANY_BIT                                                                              | Argument type                        |
| MIN, MAX                                            | Two or more ANY_ELEMENTARY values                                                    | Common type                          |
| LIMIT                                               | Three ANY_ELEMENTARY values (lower, input, upper)                                    | Common type                          |
| SEL                                                 | BOOL selector, two compatible ANY_ELEMENTARY values                                  | Common type of values                |
| MUX                                                 | Independently typed ANY_INT selector, two or more compatible ANY_ELEMENTARY values   | Common type of values                |
| GT, GE, EQ, LE, LT                                  | Two or more compatible ANY_ELEMENTARY values                                         | BOOL (all adjacent comparisons hold) |
| NE                                                  | Two compatible ANY_ELEMENTARY values                                                 | BOOL                                 |
| `TRUNC_<B>`                                         | ANY_REAL                                                                             | Integer B                            |
| `<A>_TRUNC_<B>`                                     | One value assignable to real A                                                       | Integer B                            |
| `<A>_BCD_TO_<B>`                                    | One value assignable to bit string A                                                 | Integer B                            |
| `<A>_TO_BCD_<B>`                                    | One value assignable to integer A                                                    | Bit string B                         |
| `<A>_TO_<B>`                                        | One value assignable to A                                                            | B                                    |
| `TO_<B>`                                            | One value from a supported conversion source family                                  | B                                    |
| ADD_TIME, SUB_TIME                                  | TIME, TIME                                                                           | TIME                                 |
| ADD_TOD_TIME, SUB_TOD_TIME                          | TOD, TIME                                                                            | TOD                                  |
| ADD_DT_TIME, SUB_DT_TIME                            | DT, TIME                                                                             | DT                                   |
| SUB_DATE_DATE, SUB_TOD_TOD, SUB_DT_DT               | Two DATE, TOD or DT values respectively                                              | TIME                                 |
| MUL_TIME, DIV_TIME                                  | TIME, independently typed ANY_NUM factor                                             | TIME                                 |
| Long arithmetic forms                               | Replace TIME/TOD/DT/DATE with LTIME/LTOD/LDT/LDATE in the names and signatures above | Corresponding long result            |
| CONCAT_DATE_TOD                                     | DATE, TOD                                                                            | DT                                   |
| CONCAT_DATE_LTOD                                    | DATE or LDATE, LTOD                                                                  | LDT                                  |
| CONCAT_DATE                                         | YEAR, MONTH, DAY (independent ANY_INT)                                               | DATE                                 |
| CONCAT_TOD, CONCAT_LTOD                             | HOUR, MINUTE, SECOND, MILLISECOND (independent ANY_INT)                              | TOD / LTOD                           |
| CONCAT_DT, CONCAT_LDT                               | All seven date and time components (independent ANY_INT)                             | DT / LDT                             |
| SPLIT_DATE                                          | IN: DATE or LDATE; YEAR, MONTH, DAY: INT outputs                                     | BOOL                                 |
| SPLIT_TOD, SPLIT_LTOD                               | IN: TOD / LTOD; HOUR, MINUTE, SECOND, MILLISECOND: INT outputs                       | BOOL                                 |
| SPLIT_DT, SPLIT_LDT                                 | IN: DT / LDT; all seven INT component outputs                                        | BOOL                                 |
| DAY_OF_WEEK                                         | DATE or LDATE                                                                        | INT (0 = Sunday)                     |

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

### Function output assignment

Standard functions may be called as statements, discarding their return value.
Time/date functions also accept formal inputs with `:=`: arithmetic and date/time
pair concatenation use IN1/IN2, component concatenation uses the component names
above, and split/weekday functions use IN. Formal arguments may be reordered;
positional and formal arguments cannot be mixed. The compiler orders inputs by
the descriptor before lowering, while output assignments keep their source order.

`SPLIT_DATE(IN := D#2024-02-29, YEAR => y, MONTH => m, DAY => d);` writes
2024, 2 and 29 and returns TRUE. All component outputs are INT, including long
forms; milliseconds discard sub-millisecond precision. Each target must be writable
and accept INT through an ADR 0013 implicit conversion (for example INT, DINT,
LINT, REAL or LREAL). Narrowing and signed-to-unsigned output assignments are
errors. Outputs may be omitted. Unknown, duplicate or incorrectly directed formal
parameters report `call.invalid-parameter`. Standard and user FB calls accept named
`:=` inputs and `=>` outputs with the same widening rules. Positional FB inputs
report `fb.unsupported-call`; FB calls within expressions report
`fb.call-in-expression`. Named time/date calls are not constant expressions.

## User-defined POUs and function calls

`compileProject` first collects a case-insensitive namespace shared by all POU
names and every standard function (including conversions, truncations and BCD
forms), standard FB and typed FB name, and elementary type name. A duplicate POU
is reported on the later declaration. Variables cannot reuse any POU name;
`decl.name-collision.kind` is `function` for a function and `type` for a PROGRAM
or function block. The function's implicit result variable is the sole exception:
inside its body the function name can be assigned and read.

A FUNCTION supports elementary `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT` and `VAR` declarations.
Initializers are optional except on `VAR_IN_OUT`, where they are forbidden. `FUNCTION F : REAL` returns its result variable;
`FUNCTION F` has no result and is callable only as a statement. Functions cannot
declare `VAR_TEMP`, FB instances, or direct addresses.
A PROGRAM cannot be called and cannot declare `VAR_INPUT`, `VAR_OUTPUT` or
`VAR_IN_OUT`. Direct addresses remain restricted to the PROGRAM.

Formal calls use `:=` inputs and `=>` outputs without mixing positional arguments.
Omitted inputs start from their declared initial values; an empty `F()` uses these
defaults too when there are no required in-outs. An input-only function also accepts exactly one positional argument
per input in declaration order. A function with outputs or in-outs requires formal arguments.
Input constants receive their parameter type and typed inputs allow only implicit
widening (ADR 0013). Outputs follow assignment rules, including writable variable,
bit and standard FB input targets. Unknown, duplicate and misdirected parameters
are errors. Standard functions continue to require every input.

User function calls are never constant expressions. All function bodies are checked,
even when unreachable from the PROGRAM; direct and indirect recursion are errors.
These semantics follow ADR 0014, based on the 3rd edition and secondary sources;
its standard-dependent choices await verification against the 4th edition.

## User function blocks

A FUNCTION_BLOCK supports elementary VAR_INPUT, VAR_OUTPUT, VAR_IN_OUT, VAR and VAR_TEMP.
Persistent standard or user FB instances may appear only in VAR of PROGRAM or
FUNCTION_BLOCK; other sections report `fb.invalid-instance-section`, and functions
cannot declare instances. Blocks cannot contain themselves directly or through
other blocks (`pou.recursion`), including unused definitions. AT declarations in
blocks report `pou.direct-address`.

Outside an instance, inputs are readable/writable and outputs are readable.
VAR, VAR_TEMP and VAR_IN_OUT members report `fb.unknown-member`; a nested instance is private
to its declaring block. Calls permit only formal arguments. Omitted inputs keep
their previous values. `=>` sources must be outputs, may be omitted, and cannot be
duplicated; targets follow assignment rules, including public user FB inputs.
Inputs get contextual constant typing and implicit widening. RETURN exits only the
current block. PROGRAM VAR_TEMP starts from its declared/default initializer each
scan; block VAR_TEMP restarts each call. Neither has a monitored VariableId. A temporary cannot have an AT address
(`decl.temp-address`); directly represented storage belongs to PROGRAM VAR.

### In-out parameters

`VAR_IN_OUT` parameters use `:=` in formal calls and must be supplied on every
call (`call.missing-in-out`), including repeated calls to a block instance.
In-out declarations cannot have initializers (`decl.in-out-initializer`): the value
always belongs to the caller's actual variable. This is a project restriction;
verification against the 4th edition remains pending with the other ADR 0014 rules.
The actual must be a writable scalar variable of the caller, with exactly the
parameter's elementary type; there is no contextual literal typing or widening.
Expressions, literals, parenthesized expressions, bit access and `inst.X` members
report `call.in-out-variable`; a different scalar type reports `call.in-out-type`.
CONSTANT declarations remain unsupported and cannot supply actuals; `VAR_IN_OUT
CONSTANT` is unsupported too. FB instances, arrays and structures are not in-out
parameters in this milestone.

Caller VAR_INPUT, VAR_OUTPUT and VAR_IN_OUT variables can be passed on, as can
locals, temporaries and a function's result variable. Two in-outs may alias the
same actual, and an input may read that actual in the same call. Inputs are
copied in source order before the body runs; aliases then expose writes
immediately. The runtime does not copy in-outs back at return. They cannot be
accessed as public block members and have no separate monitoring VariableId.

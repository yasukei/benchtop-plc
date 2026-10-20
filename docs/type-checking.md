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
The supported paths are SINT → INT → DINT; USINT → UINT → UDINT;
USINT → INT and UINT → DINT; integers up to 16 bits → REAL; integers up to
32 bits and REAL → LREAL; and BOOL → BYTE → WORD → DWORD. Every narrowing
conversion requires a conversion function; the diagnostic includes the localizable
`explicit-conversion` hint.
These rules apply to assignments, initializers, FB inputs, fixed function
parameters, CASE labels and FOR start/end/step values (the control variable's type).

Operators and generic MIN/MAX/LIMIT/SEL value arguments use one set-based common
type, independent of argument order: select a candidate all operands can widen to
that itself widens to all other candidates. If none exists and all operands are
integers, repeat that selection with only integer candidates. For example INT +
UINT is DINT, DINT + REAL is LREAL, REAL + LREAL is LREAL, and MAX(INT, UINT, REAL)
is REAL. Selection considers the full ADR 0012 type set, including types not yet
implemented. DINT + UDINT selects LINT, then reports an error because LINT is
unavailable; it never falls back to LREAL. Incompatible types are errors. Unary minus accepts signed integers, reals
and TIME, and rejects unsigned integers. All comparisons accept BOOL (`FALSE < TRUE`).
AND, &, OR, XOR and NOT accept BOOL and bit strings only. Operands widen to their
common bit type (TRUE AND BYTE#3 is BYTE#1). Comparisons order bit strings by their
unsigned numeric value. Bit access `x.n` reads or assigns a BOOL on a BYTE, WORD or
DWORD variable; n is a decimal constant index, zero-based and less than its width.
An invalid index reports `type.invalid-bit-access`. Assignment changes only that bit.
TIME supports TIME ± TIME and scaling with an independently typed numeric factor.

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
3. Otherwise DINT for an integer in range, then LREAL only if it holds that integer
   exactly; real constants default to LREAL. The intermediate LINT fallback from
   ADR 0013 will become available when LINT is implemented.

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
REAL and LREAL, plus T#/TIME#.
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

| Function     | Arguments                                           | Result                         |
| ------------ | --------------------------------------------------- | ------------------------------ |
| ABS          | One numeric value                                   | Argument type                  |
| MIN, MAX     | Two or more numeric values                          | Set-based common type          |
| LIMIT        | Three numeric values                                | Set-based common type          |
| SEL          | BOOL selector, two compatible values                | Common type of value arguments |
| `<A>_TO_<B>` | One value assignable to A                           | B                              |
| `TO_<B>`     | One value from a supported conversion source family | B                              |

Numeric conversions cover every distinct ordered pair among the supported integers
and reals. BOOL_TO_<integer> returns 0 or 1. TIME ↔ integer conversions are extensions
in milliseconds. Overloaded TO_<type> selects from the argument's actual type;
identity inputs are accepted. Fixed source parameters accept implicit widening,
with untyped constants checked directly against that source type.

Integer conversions wrap; real → integer rounds nearest, ties to even, then wraps.
Integer → real and LREAL → REAL round nearest, ties to even. REAL overflow faults
at runtime and is rejected in a constant expression.

Conversions among BOOL/BYTE/WORD/DWORD keep the rightmost bits and zero-fill wider
results; conversion to BOOL tests only bit zero. Integer ↔ bit-string conversions
transfer the source-width two's-complement pattern without sign extension:
INT_TO_DWORD(-1) is 16#0000FFFF, while WORD_TO_INT(16#FFFF) is -1.
REAL_TO_DWORD and DWORD_TO_REAL reinterpret IEEE binary32 bits. NaN and infinity
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

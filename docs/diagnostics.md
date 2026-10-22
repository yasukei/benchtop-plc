# Diagnostics

`@benchtop-plc/core` exports `Diagnostic`, `DiagnosticCode`, `DiagnosticArgs`,
`DiagnosticSeverity` and `AssignmentHint`. `Diagnostic` is a union discriminated
by `code`: each code has exactly the argument shape listed below. The optional
type parameter, such as `Diagnostic<"runtime.watchdog">`, selects a subset while
retaining that correlation. Every diagnostic has `severity: "error" | "warning"`
and may carry a `SourceSpan` (one-based positions, exclusive end). `pou?: string`
retains the source POU name and identifies the text to which the span belongs.
Compiler diagnostics carry it once a header is known, including lexical/syntax
failures after that header; project-level errors omit it. Runtime execution faults
name the executing POU, preserving the innermost function through nested calls.
Faults in a user block body also carry `instance?: string`, the canonical dotted path
(for example `M1.DELAY`). A function called from a block has no instance path
while its body runs. The web catalogs include a block path alongside the POU name.

## Naming and compatibility

Codes use `<category>.<lower-kebab-case-reason>`. Categories are `lex` (lexing),
`syntax` (parsing), `pou` (project-wide POU rules), `decl` (declarations), `name` (name resolution), `type` (type
checking), `flow` (control flow), `fb` (function blocks), `call` (function calls)
and `runtime` (execution faults and command rejections). Codes and argument keys are stable identifiers:
do not rename or repurpose an existing code. Add a new code for a new meaning and
update this table, tests and every UI catalog when catalogs are available.

The compiler and runtime supply data, never localized sentences. The UI chooses
message templates from its i18n catalog using `code` and interpolates `args`.
There is no `message` field. The English meanings below are developer reference
documentation, not message templates. Translation catalogs are outside issue #4.

## Argument conventions

- `{}` means an object with no keys; `args` itself is always required.
- Names, members, literals, characters and addresses retain source spelling.
- `DataType` is `BOOL | INT | DINT | UINT | REAL | LREAL | TIME`.
  `FunctionBlockType` is the existing core union of supported standard FB names.
- `expected` in syntax diagnostics is a raw token spelling, canonical token-kind
  identifier, or stable construct identifier, never a localized description such
  as "an identifier". The parser's non-spelling vocabulary is `identifier`,
  `address`, `eof` (token kinds) and `expression` (a construct).
  `found` retains the actual non-EOF token's source spelling.
  `syntax.expected-token` and `syntax.expected-identifier` only describe an actual
  non-EOF token; use the selection rules below when input ends.
  `syntax.missing-end.expected` is an `END_*` keyword.
- Assignment `hint`, when present, is the identifier `explicit-conversion`.
  The UI localizes that suggestion; producers must not pass a sentence.
- Operand mismatch uses `left` for a unary operand and `right: null`; binary
  operations supply both types. Operators use the core unary/binary operator
  unions (source `&` is normalized to `AND`).
- Argument counts are nonnegative integers. `min`/`max` are inclusive; equal
  values mean an exact arity, and `max: null` means no upper bound. Argument
  `index` is zero-based; `expected` is a readonly nonempty tuple of accepted types
  at that position, and `found` is the actual type. Shared constant signature
  tables can be passed without copying. Overload selection remains the compiler's
  responsibility.
- Watchdog `limit` is the positive integer loop iteration limit, not elapsed time.
- Objects contain JSON-safe data. Omit optional fields instead of setting them
  to `undefined`; numbers must be finite. These are producer invariants, not
  runtime validation performed by the TypeScript types.

## Syntax diagnostic selection

At EOF, report the innermost unfinished construct first:

- Use `syntax.missing-end` when a block's header and contained statements or
  declarations are complete and only its closing `END_*` keyword is missing.
  For nested open blocks, name the innermost missing terminator.
- Use `syntax.unexpected-eof` when input ends within another unfinished construct,
  including an expression, identifier, declaration, header or statement. This
  takes precedence over missing terminators of enclosing blocks.
- Neither `syntax.expected-token` nor `syntax.expected-identifier` carries
  `found: "EOF"`. Use them when a real non-EOF token occupies the required
  position. If an enclosing block's terminator is encountered before the current
  block's required `END_*`, use `syntax.missing-end` for the current block instead.

Emit one primary diagnostic for that EOF position; do not add cascading
missing-terminator diagnostics for every enclosing block. Lexical errors such as
`lex.unterminated-comment` remain lexical diagnostics rather than being relabeled
as syntax errors.

| Input suffix                                    | Diagnostic              | Arguments                           |
| ----------------------------------------------- | ----------------------- | ----------------------------------- |
| `IF x THEN y := 1;` then EOF                    | `syntax.missing-end`    | `{ expected: "END_IF" }`            |
| `IF x THEN y :=` then EOF                       | `syntax.unexpected-eof` | `{}`                                |
| `IF x` then EOF (missing THEN)                  | `syntax.unexpected-eof` | `{}`                                |
| `IF x THEN y := 1` then EOF (missing semicolon) | `syntax.unexpected-eof` | `{}`                                |
| `IF x THEN WHILE y DO` then EOF                 | `syntax.missing-end`    | `{ expected: "END_WHILE" }`         |
| `IF x THEN y := 1; END_PROGRAM`                 | `syntax.missing-end`    | `{ expected: "END_IF" }`            |
| `IF x DO`                                       | `syntax.expected-token` | `{ expected: "THEN", found: "DO" }` |

## Milestone 1 codes

| Code                             | Meaning                                              | Arguments                                                                                        |
| -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `lex.unterminated-comment`       | Block comment has no closing delimiter               | `{}`                                                                                             |
| `lex.invalid-character`          | Character cannot begin a token                       | `{ character: string }`                                                                          |
| `lex.malformed-direct-address`   | Direct address has invalid syntax                    | `{ address: string }`                                                                            |
| `lex.malformed-number`           | Numeric literal has invalid syntax                   | `{ literal: string }`                                                                            |
| `syntax.expected-token`          | Expected token differs from the next token           | `{ expected: string; found: string }`                                                            |
| `syntax.expected-identifier`     | Identifier required at this position                 | `{ found: string }`                                                                              |
| `syntax.reserved-identifier`     | Reserved word used as an identifier                  | `{ name: string }`                                                                               |
| `syntax.assignment-operator`     | `=` used where assignment requires `:=`              | `{}`                                                                                             |
| `syntax.unexpected-eof`          | Input ends before the construct is complete          | `{}`                                                                                             |
| `syntax.missing-end`             | Required closing `END_*` keyword is absent           | `{ expected: END_* keyword }`                                                                    |
| `decl.unknown-type`              | Declaration refers to an unknown type                | `{ name: string }`                                                                               |
| `decl.duplicate`                 | Name is declared more than once                      | `{ name: string }`                                                                               |
| `decl.name-collision`            | Name collides with a type or function                | `{ name: string; kind: "type" \| "function" }`                                                   |
| `decl.direct-address-type`       | Direct address applied to a non-BOOL declaration     | `{ name: string; type: string }`                                                                 |
| `decl.temp-address`              | Direct address on a temporary variable               | `{}`                                                                                             |
| `decl.at-multiple-names`         | `AT` applied to more than one declared name          | `{}`                                                                                             |
| `decl.address-out-of-range`      | Valid address syntax refers outside supported I/O    | `{ address: string }`                                                                            |
| `decl.nonconstant-initializer`   | Initial value is not a constant expression           | `{ name: string }`                                                                               |
| `decl.fb-initializer`            | Initial value supplied for an FB instance            | `{ name: string }`                                                                               |
| `decl.in-out-initializer`        | Initial value supplied for an in-out parameter       | `{ name: string }`                                                                               |
| `name.undeclared`                | Identifier has no declaration                        | `{ name: string }`                                                                               |
| `type.portability`               | Warning: conversion differs from vendor runtimes     | `{ function: string }`                                                                           |
| `type.invalid-constant`          | Invalid constant, literal range or REAL overflow     | `{}`                                                                                             |
| `type.case-label-not-constant`   | Integer CASE label depends on a variable or call     | `{}`                                                                                             |
| `fb.duplicate-input`             | Named FB input is supplied more than once            | `{ name: string; member: string }`                                                               |
| `type.assign-mismatch`           | Value cannot be assigned to the destination type     | `{ from: DataType; to: DataType; hint?: AssignmentHint }`                                        |
| `type.operand-mismatch`          | Operator does not accept the operand types           | `{ operator: UnaryOperator \| BinaryOperator; left: DataType; right: DataType \| null }`         |
| `type.condition-not-bool`        | Statement condition is not BOOL                      | `{ statement: "IF" \| "ELSIF" \| "WHILE" \| "REPEAT" }`                                          |
| `type.case-selector-not-integer` | CASE selector is not an integer                      | `{ type: DataType }`                                                                             |
| `type.case-label-not-integer`    | CASE label or range endpoint is not an integer       | `{ type: DataType }`                                                                             |
| `type.for-variable-not-integer`  | FOR control variable is not an integer               | `{ name: string; type: DataType }`                                                               |
| `type.for-bound-not-integer`     | FOR start, end or step is not an integer             | `{ bound: "from" \| "to" \| "step"; type: DataType }`                                            |
| `flow.exit-outside-loop`         | EXIT occurs outside a loop                           | `{}`                                                                                             |
| `fb.invalid-instance-section`    | FB instance declared outside VAR                     | `{ name: string }`                                                                               |
| `fb.no-matching-variant`         | No variant accepts the selecting preset types        | `{ name: string; types: readonly DataType[] }`                                                   |
| `fb.not-function-block`          | Called instance is not a function block              | `{ name: string }`                                                                               |
| `fb.unknown-member`              | FB instance has no such member                       | `{ name: string; member: string }`                                                               |
| `fb.output-not-writable`         | Assignment attempts to write an FB output            | `{ name: string; member: string }`                                                               |
| `fb.instance-as-value`           | FB instance used as a scalar value                   | `{ name: string }`                                                                               |
| `fb.unsupported-call`            | FB statement uses positional inputs                  | `{ name: string }`                                                                               |
| `fb.call-in-expression`          | FB call used within an expression                    | `{ name: string }`                                                                               |
| `call.unknown-function`          | Function name is unknown                             | `{ name: string }`                                                                               |
| `call.invalid-parameter`         | Unknown, duplicate or misdirected formal parameter   | `{ name: string; parameter: string }`                                                            |
| `call.argument-count`            | Function call supplies the wrong number of arguments | `{ name: string; min: number; max: number \| null; found: number }`                              |
| `call.argument-type`             | Function argument has an unsupported type            | `{ name: string; index: number; expected: readonly [DataType, ...DataType[]]; found: DataType }` |
| `runtime.invalid-value`          | Non-finite result or REAL overflow                   | `{}`                                                                                             |
| `runtime.division-by-zero`       | Division has a zero divisor                          | `{}`                                                                                             |
| `runtime.watchdog`               | Loop iteration limit exceeded                        | `{ limit: number }`                                                                              |
| `runtime.for-by-zero`            | FOR step evaluates to zero                           | `{}`                                                                                             |
| `runtime.debug-target`           | Debug command target is not a loaded scalar          | `{}`                                                                                             |
| `runtime.debug-type-mismatch`    | Debug value type differs from the declaration        | `{ from: DataType; to: DataType }`                                                               |
| `runtime.debug-value`            | Invalid debug value, non-finite value or overflow    | `{}`                                                                                             |
| `runtime.write-input-mapped`     | One-shot write targets an input-mapped variable      | `{ name: string }`                                                                               |

`CommandRejectionCode` selects the four debug-command codes above. They are sent
in non-fatal `rejected` events with the originating `force` or `write` command,
not PLC `fault` events. Rejections have severity `error` but do not change the
operating state or a latched execution diagnostic. `debug-target` uses no ID
argument because an invalid ID can be non-finite and must not enter JSON data.
`debug-type-mismatch` uses `from` for the supplied value type and `to` for the
declaration type; `write-input-mapped.name` retains the declaration's spelling.
The web catalogs render all four codes in English and Japanese.

The enclosing `Diagnostic.span` identifies the offending token/expression/member
or loop when source information is available. For a missing terminator or EOF,
it may identify the insertion position with an empty span. Fault events in
`RuntimeToUiMessage` use this same union; consumers should narrow by `code` before
reading code-specific arguments. This contract does not implement diagnostic
emission, PLC execution, message rendering or untrusted-input validation.

## Project file diagnostics

| Code                   | Arguments      | Meaning                                                                                      |
| ---------------------- | -------------- | -------------------------------------------------------------------------------------------- |
| `project.invalid-xml`  | none           | Malformed XML, a DTD, or excessive XML nesting.                                              |
| `project.missing`      | `path: string` | A required element or attribute is absent.                                                   |
| `project.unsupported`  | `path: string` | A construct is outside the supported TC6 subset, or an extension version is unsupported.     |
| `project.invalid`      | `path: string` | Invalid metadata, task binding/duration/priority, panel JSON, or declaration data.           |
| `project.dropped-data` | `name: string` | Warning: unknown vendor data was dropped.                                                    |
| `project.stale-source` | none           | Warning: preserved editor text disagrees with the standard XML; canonical text was imported. |

Paths identify XML elements/attributes or model fields; they are diagnostic
arguments, not rendered English messages. Project conversion can also return the
compiler's lexer/parser diagnostics with source spans. See
[Project files](project-format.md) for the supported format and extension rules.

`type.invalid-bit-access` carries `{ type, bit }` for an unsupported scalar type or
an index outside a bit string's width. `type.portability` is a warning carrying
`{ function: string }` for REAL ↔ DWORD, LREAL ↔ LWORD and bit strings → BOOL
conversions whose vendor semantics may differ. It spans the entire call and names
the resolved typed function, including for overloaded `TO_` calls. The English and
Japanese messages explain bit-pattern reinterpretation or rightmost-bit selection.
It does not prevent compilation, loading or execution.

## User-defined POU codes

| Code                             | Meaning                                                            | Arguments                           |
| -------------------------------- | ------------------------------------------------------------------ | ----------------------------------- |
| `pou.duplicate`                  | Duplicate POU name, on the later POU                               | `{ name: string }`                  |
| `pou.name-collision`             | POU name conflicts with a standard function, FB or elementary type | `{ name: string }`                  |
| `pou.program-count`              | Project does not have exactly one PROGRAM; no POU or span          | `{ found: number }`                 |
| `pou.unsupported-kind`           | Reserved compatibility code; no longer emitted for FUNCTION_BLOCK  | `{ name: string }`                  |
| `pou.invalid-section`            | Variable section unsupported in this POU kind                      | `{ section: string; kind: string }` |
| `pou.direct-address`             | Direct address outside the PROGRAM                                 | `{}`                                |
| `pou.function-block-in-function` | FB instance declared in a function                                 | `{}`                                |
| `pou.recursion`                  | Direct or indirect recursive call or FB containment                | `{ name: string }`                  |
| `call.program`                   | Attempt to call a PROGRAM                                          | `{ name: string }`                  |
| `call.no-result`                 | No-result function used in an expression                           | `{ name: string }`                  |
| `call.formal-required`           | Positional call to a function with outputs or in-outs              | `{ name: string }`                  |

`pou.invalid-section.kind` is the AST kind (`program`, `function`, or
`functionBlock`); `section` is the canonical ST section keyword. Localizers
translate these identifiers. The existing `decl.name-collision` kinds also cover
POUs: `function` for a user function; `type` for a PROGRAM or user FB.

In-out call errors apply to both functions and user function blocks:

| Code                   | Meaning                                                                                                                | Arguments                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `call.in-out-variable` | Actual is not a writable scalar variable of the caller (expressions, literals, bits and instance members are rejected) | `{}`                                  |
| `call.in-out-type`     | Actual type differs from the declared type; implicit widening is forbidden                                             | `{ from: DataType; to: DataType }`    |
| `call.missing-in-out`  | Required in-out omitted from a call                                                                                    | `{ name: string; parameter: string }` |

`call.in-out-variable` and `call.in-out-type` span the actual argument;
`call.missing-in-out` spans the call. External reads/writes of `inst.io` report
`fb.unknown-member`. Positional functions with in-outs report
`call.formal-required`; positional blocks retain `fb.unsupported-call`.

`decl.in-out-initializer` rejects an initializer on a `VAR_IN_OUT` declaration,
with `{ name: string }` naming its first declared variable and a span covering
the initializer expression. It applies to both functions and function blocks,
including unused definitions. XML exchange preserves this representable semantic
error, while retaining the usual initializer type and range checks.

## Named constant codes

| Code                         | Meaning                                                                             | Arguments             |
| ---------------------------- | ----------------------------------------------------------------------------------- | --------------------- |
| `decl.constant-section`      | CONSTANT on a section other than VAR, including an empty section                    | `{ section: string }` |
| `decl.constant-type`         | An FB instance declared CONSTANT                                                    | `{}`                  |
| `decl.constant-address`      | CONSTANT combined with AT                                                           | `{}`                  |
| `decl.constant-not-writable` | Constant used as assignment/bit target, FOR control, output target or in-out actual | `{ name: string }`    |
| `decl.constant-order`        | Constant initializer references a constant not initialized earlier in this POU      | `{ name: string }`    |

Section errors span the section keyword, type errors the declared type, and
address errors the AT address. Write and order errors span the referenced name.
Existing `decl.nonconstant-initializer` rejects mutable references and other
nonconstant expressions; `type.invalid-constant` handles out-of-range initializers
and arithmetic faults. Uses of a constant whose initializer has already failed
do not add declaration-order errors; the initializer diagnostic identifies the cause.
Named constants use the existing name collision and
bit-index diagnostics. All codes have English and Japanese UI templates.

Overloaded standard timers and counters report `fb.no-matching-variant` on the
instance's declaration name when selecting `PT`/`PV` types have no common type or
no accepting variant (for example LINT with ULINT, or a BYTE preset). `types`
contains the selecting binding types in source order. Non-selecting bindings are
checked after resolution with ordinary assignment diagnostics; an untyped
`c(PV := 100000)` with no typed binding reports `type.invalid-constant` against
the default INT. See [type-checking.md](type-checking.md#overloaded-standard-timers-and-counters).

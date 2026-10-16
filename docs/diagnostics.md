# Diagnostics

`@benchtop-plc/core` exports `Diagnostic`, `DiagnosticCode`, `DiagnosticArgs`,
`DiagnosticSeverity` and `AssignmentHint`. `Diagnostic` is a union discriminated
by `code`: each code has exactly the argument shape listed below. The optional
type parameter, such as `Diagnostic<"runtime.watchdog">`, selects a subset while
retaining that correlation. Every diagnostic has `severity: "error" | "warning"`
and may carry a `SourceSpan` (one-based positions, exclusive end).

## Naming and compatibility

Codes use `<category>.<lower-kebab-case-reason>`. Categories are `lex` (lexing),
`syntax` (parsing), `decl` (declarations), `name` (name resolution), `type` (type
checking), `flow` (control flow), `fb` (function blocks), `call` (function calls)
and `runtime` (execution faults). Codes and argument keys are stable identifiers:
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
| `decl.direct-address-type`       | Direct address applied to a non-BOOL declaration     | `{ name: string; type: DataType \| FunctionBlockType }`                                          |
| `decl.at-multiple-names`         | `AT` applied to more than one declared name          | `{}`                                                                                             |
| `decl.address-out-of-range`      | Valid address syntax refers outside supported I/O    | `{ address: string }`                                                                            |
| `decl.nonconstant-initializer`   | Initial value is not a constant expression           | `{ name: string }`                                                                               |
| `decl.fb-initializer`            | Initial value supplied for an FB instance            | `{ name: string }`                                                                               |
| `name.undeclared`                | Identifier has no declaration                        | `{ name: string }`                                                                               |
| `type.assign-mismatch`           | Value cannot be assigned to the destination type     | `{ from: DataType; to: DataType; hint?: AssignmentHint }`                                        |
| `type.operand-mismatch`          | Operator does not accept the operand types           | `{ operator: UnaryOperator \| BinaryOperator; left: DataType; right: DataType \| null }`         |
| `type.condition-not-bool`        | Statement condition is not BOOL                      | `{ statement: "IF" \| "ELSIF" \| "WHILE" \| "REPEAT" }`                                          |
| `type.case-selector-not-integer` | CASE selector is not an integer                      | `{ type: DataType }`                                                                             |
| `type.case-label-not-integer`    | CASE label or range endpoint is not an integer       | `{ type: DataType }`                                                                             |
| `type.for-variable-not-integer`  | FOR control variable is not an integer               | `{ name: string; type: DataType }`                                                               |
| `type.for-bound-not-integer`     | FOR start, end or step is not an integer             | `{ bound: "from" \| "to" \| "step"; type: DataType }`                                            |
| `flow.exit-outside-loop`         | EXIT occurs outside a loop                           | `{}`                                                                                             |
| `fb.not-function-block`          | Called instance is not a function block              | `{ name: string }`                                                                               |
| `fb.unknown-member`              | FB instance has no such member                       | `{ name: string; member: string }`                                                               |
| `fb.output-not-writable`         | Assignment attempts to write an FB output            | `{ name: string; member: string }`                                                               |
| `fb.instance-as-value`           | FB instance used as a scalar value                   | `{ name: string }`                                                                               |
| `fb.call-in-expression`          | FB call used within an expression                    | `{ name: string }`                                                                               |
| `call.unknown-function`          | Function name is unknown                             | `{ name: string }`                                                                               |
| `call.argument-count`            | Function call supplies the wrong number of arguments | `{ name: string; min: number; max: number \| null; found: number }`                              |
| `call.argument-type`             | Function argument has an unsupported type            | `{ name: string; index: number; expected: readonly [DataType, ...DataType[]]; found: DataType }` |
| `runtime.division-by-zero`       | Division or MOD has a zero divisor                   | `{}`                                                                                             |
| `runtime.watchdog`               | Loop iteration limit exceeded                        | `{ limit: number }`                                                                              |
| `runtime.for-by-zero`            | FOR step evaluates to zero                           | `{}`                                                                                             |

The enclosing `Diagnostic.span` identifies the offending token/expression/member
or loop when source information is available. For a missing terminator or EOF,
it may identify the insertion position with an empty span. Fault events in
`RuntimeToUiMessage` use this same union; consumers should narrow by `code` before
reading code-specific arguments. This contract does not implement diagnostic
emission, PLC execution, message rendering or untrusted-input validation.

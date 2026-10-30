# Diagnostics

`@benchtop-plc/core` exports `Diagnostic`, `DiagnosticCode`, `DiagnosticArgs`,
`DiagnosticSeverity` and `AssignmentHint`. `Diagnostic` is a union discriminated
by `code`: each code has exactly the argument shape listed below. The optional
type parameter, such as `Diagnostic<"runtime.watchdog">`, selects a subset while
retaining that correlation. Every diagnostic has `severity: "error" | "warning"`
and may carry a `SourceSpan` (one-based positions, exclusive end). `pou?: string`
retains the source POU, data type or configuration name and identifies the text to which the span belongs.
Compiler diagnostics carry it once a header is known, including lexical/syntax
failures after that header; project-level errors omit it. Runtime execution faults
name the executing POU, preserving the innermost function through nested calls.
Faults in a user block body also carry `instance?: string`, the canonical dotted path
(for example `mainInstance.M1.DELAY`). A function called from a block identifies the owning program instance
rather than the nested block path while its body runs. The web catalogs include a block path alongside the POU name.

## Naming and compatibility

Codes use `<category>.<lower-kebab-case-reason>`. Categories are `lex` (lexing),
`syntax` (parsing), `pou` (project-wide POU rules), `decl` (declarations), `name` (name resolution), `type` (type
checking), `flow` (control flow), `fb` (function blocks), `call` (function calls), `config` (configuration rules)
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
- Type arguments use `TypeDescriptor`: elementary `DataType` names, named types or
  inline descriptors. UI catalogs call `formatType` to show source-like text.
  `FunctionBlockType` is the existing core union of supported standard FB names.
- `expected` in syntax diagnostics is a raw token spelling, canonical token-kind
  identifier, or stable construct identifier, never a localized description such
  as "an identifier". The parser's non-spelling vocabulary is `identifier`,
  `address`, `integer`, `eof` (token kinds) and `expression` (a construct).
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

| Code                              | Meaning                                                                                  | Arguments                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `lex.unterminated-comment`        | Block comment has no closing delimiter                                                   | `{}`                                                                                                               |
| `lex.invalid-character`           | Character cannot begin a token                                                           | `{ character: string }`                                                                                            |
| `lex.malformed-direct-address`    | Direct address has invalid syntax                                                        | `{ address: string }`                                                                                              |
| `lex.malformed-number`            | Numeric literal has invalid syntax                                                       | `{ literal: string }`                                                                                              |
| `syntax.expected-token`           | Expected token differs from the next token                                               | `{ expected: string; found: string }`                                                                              |
| `syntax.expected-identifier`      | Identifier required at this position                                                     | `{ found: string }`                                                                                                |
| `syntax.reserved-identifier`      | Reserved word used as an identifier                                                      | `{ name: string }`                                                                                                 |
| `syntax.assignment-operator`      | `=` used where assignment requires `:=`                                                  | `{}`                                                                                                               |
| `syntax.unexpected-eof`           | Input ends before the construct is complete                                              | `{}`                                                                                                               |
| `syntax.missing-end`              | Required closing `END_*` keyword is absent                                               | `{ expected: END_* keyword }`                                                                                      |
| `decl.unknown-type`               | Declaration refers to an unknown type                                                    | `{ name: string }`                                                                                                 |
| `decl.duplicate`                  | Name is declared more than once                                                          | `{ name: string }`                                                                                                 |
| `decl.name-collision`             | Name collides with a type or function                                                    | `{ name: string; kind: "type" \| "function" }`                                                                     |
| `decl.direct-address-type`        | Declaration type does not bind the direct-address size                                   | `{ name: string; type: string }`                                                                                   |
| `decl.temp-address`               | Direct address on a temporary variable                                                   | `{}`                                                                                                               |
| `decl.parameter-address`          | Direct address on a PROGRAM input or output                                              | `{}`                                                                                                               |
| `decl.at-multiple-names`          | `AT` applied to more than one declared name                                              | `{}`                                                                                                               |
| `decl.address-out-of-range`       | Valid address syntax refers outside supported I/O                                        | `{ address: string }`                                                                                              |
| `decl.nonconstant-initializer`    | Initial value is not a constant expression                                               | `{ name: string }`                                                                                                 |
| `decl.fb-initializer`             | Initial value supplied for an FB instance                                                | `{ name: string }`                                                                                                 |
| `decl.in-out-initializer`         | Initial value supplied for an in-out parameter                                           | `{ name: string }`                                                                                                 |
| `name.undeclared`                 | Identifier has no declaration                                                            | `{ name: string }`                                                                                                 |
| `type.portability`                | Warning: conversion differs from vendor runtimes                                         | `{ function: string }`                                                                                             |
| `type.ambiguous-enumeration`      | Unqualified enum member clashes with a variable or constant                              | `{ name: string }`                                                                                                 |
| `type.not-array`                  | Indexing applied to a non-array value                                                    | `{ type: TypeDescriptor }`                                                                                         |
| `type.array-index-count`          | Number of indices differs from the array's dimensions                                    | `{ expected: number; found: number }`                                                                              |
| `type.array-index-not-integer`    | Index has a real, Boolean, enumerated or array type                                      | `{ type: TypeDescriptor }`                                                                                         |
| `type.array-initializer-required` | Array declaration initializer is not a list                                              | `{ type: TypeDescriptor }`                                                                                         |
| `type.invalid-constant`           | Invalid constant, literal range or REAL overflow                                         | `{}`                                                                                                               |
| `type.case-label-not-constant`    | Integer CASE label depends on a variable or call                                         | `{}`                                                                                                               |
| `fb.duplicate-input`              | Named FB input is supplied more than once                                                | `{ name: string; member: string }`                                                                                 |
| `type.assign-mismatch`            | Value cannot be assigned to the destination type                                         | `{ from: TypeDescriptor; to: TypeDescriptor; hint?: AssignmentHint }`                                              |
| `type.operand-mismatch`           | Operator does not accept the operand types                                               | `{ operator: UnaryOperator \| BinaryOperator; left: TypeDescriptor; right: TypeDescriptor \| null }`               |
| `type.condition-not-bool`         | Statement condition is not BOOL                                                          | `{ statement: "IF" \| "ELSIF" \| "WHILE" \| "REPEAT" }`                                                            |
| `type.case-selector-not-integer`  | CASE selector is not an integer                                                          | `{ type: TypeDescriptor }`                                                                                         |
| `type.case-label-not-integer`     | CASE label or range endpoint is not an integer                                           | `{ type: TypeDescriptor }`                                                                                         |
| `type.for-variable-subrange`      | Subrange FOR control variables are unsupported                                           | `{ name: string; type: TypeDescriptor }`                                                                           |
| `type.for-variable-not-integer`   | FOR control variable is not an integer                                                   | `{ name: string; type: TypeDescriptor }`                                                                           |
| `type.for-bound-not-integer`      | FOR start, end or step is not an integer                                                 | `{ bound: "from" \| "to" \| "step"; type: TypeDescriptor }`                                                        |
| `flow.exit-outside-loop`          | EXIT occurs outside a loop                                                               | `{}`                                                                                                               |
| `fb.invalid-instance-section`     | FB instance declared outside VAR or VAR_EXTERNAL                                         | `{ name: string }`                                                                                                 |
| `fb.no-matching-variant`          | No variant accepts the selecting preset types                                            | `{ name: string; types: readonly TypeDescriptor[] }`                                                               |
| `fb.not-function-block`           | Called instance is not a function block                                                  | `{ name: string }`                                                                                                 |
| `fb.unknown-member`               | FB instance has no such member                                                           | `{ name: string; member: string }`                                                                                 |
| `fb.output-not-writable`          | Assignment attempts to write an FB output                                                | `{ name: string; member: string }`                                                                                 |
| `fb.instance-as-value`            | FB instance used as a scalar value                                                       | `{ name: string }`                                                                                                 |
| `fb.unsupported-call`             | FB statement uses positional inputs                                                      | `{ name: string }`                                                                                                 |
| `fb.call-in-expression`           | FB call used within an expression                                                        | `{ name: string }`                                                                                                 |
| `call.unknown-function`           | Function name is unknown                                                                 | `{ name: string }`                                                                                                 |
| `call.invalid-parameter`          | Unknown, duplicate or misdirected formal parameter                                       | `{ name: string; parameter: string }`                                                                              |
| `call.argument-count`             | Function call supplies the wrong number of arguments                                     | `{ name: string; min: number; max: number \| null; found: number }`                                                |
| `call.argument-type`              | Function argument has an unsupported type                                                | `{ name: string; index: number; expected: readonly [TypeDescriptor, ...TypeDescriptor[]]; found: TypeDescriptor }` |
| `runtime.subrange-violation`      | Dynamic value stored outside the declared limits                                         | `{ value: number \| string; lower: number \| string; upper: number \| string }`                                    |
| `runtime.load-failed`             | Worker could not load the program; connection remains available for retry                | `{}`                                                                                                               |
| `runtime.invalid-value`           | Non-finite result/view read, REAL overflow, invalid string position/length or conversion | `{}`                                                                                                               |
| `runtime.division-by-zero`        | Division has a zero divisor                                                              | `{}`                                                                                                               |
| `runtime.watchdog`                | Loop iteration limit exceeded                                                            | `{ limit: number }`                                                                                                |
| `runtime.for-by-zero`             | FOR step evaluates to zero                                                               | `{}`                                                                                                               |
| `runtime.debug-target`            | Debug command target is not a loaded scalar                                              | `{}`                                                                                                               |
| `runtime.debug-type-mismatch`     | Debug value type differs from the declaration                                            | `{ from: TypeDescriptor; to: TypeDescriptor }`                                                                     |
| `runtime.debug-value`             | Invalid debug value, non-finite value or overflow                                        | `{}`                                                                                                               |
| `runtime.write-input-mapped`      | One-shot write targets an input-mapped variable                                          | `{ name: string }`                                                                                                 |

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

| Code                   | Meaning                                                                                                                | Arguments                                      |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `call.in-out-variable` | Actual is not a writable scalar variable of the caller (expressions, literals, bits and instance members are rejected) | `{}`                                           |
| `call.in-out-type`     | Actual type differs from the declared type; implicit widening is forbidden                                             | `{ from: TypeDescriptor; to: TypeDescriptor }` |
| `call.missing-in-out`  | Required in-out omitted from a call                                                                                    | `{ name: string; parameter: string }`          |

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
| `decl.constant-section`      | CONSTANT on a section other than VAR or VAR_EXTERNAL, including an empty section    | `{ section: string }` |
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
contains the selecting binding types in source order. After selection fails,
preset bindings are still checked for expression and parameter errors, but are
not contextually typed or checked for assignment against the fallback INT/TIME
variant. This avoids misleading narrowing diagnostics. For successful selection,
non-selecting bindings are checked after resolution with ordinary assignment diagnostics; an untyped
`c(PV := 100000)` with no typed binding reports `type.invalid-constant` against
the default INT. See [type-checking.md](type-checking.md#overloaded-standard-timers-and-counters).

Data type source diagnostics use the type name in `pou`, `sourceKind: "dataType"`
and `sourceIndex` into the compiler's separate data type source list. Duplicate
types use `decl.duplicate`; type/POU/standard-name clashes use `decl.name-collision`;
unknown type references use `decl.unknown-type`. Invalid bounds, duplicate enum
values and out-of-range subrange constants use `type.invalid-constant`.

## Character literal diagnostics

| Code                           | Arguments | Meaning                                                       |
| ------------------------------ | --------- | ------------------------------------------------------------- |
| `lex.unterminated-string`      | `{}`      | Missing closing quote or physical line break inside a literal |
| `lex.invalid-string-escape`    | `{}`      | Unknown escape or incomplete hexadecimal escape               |
| `lex.invalid-string-character` | `{}`      | Single-byte literal contains a code unit above 16#FF          |

These diagnostics retain the source name and literal span. `type.invalid-constant`
also covers invalid string capacities, literals longer than their destination,
CHAR/WCHAR literals with other than one code unit, and typed literals with the
wrong quote width. Invalid monitor text is handled by the monitor's localized
validation message; malformed protocol values use `runtime.debug-value` and wrong
scalar discriminators use `runtime.debug-type-mismatch`.

### Array index faults

`runtime.index-out-of-range` reports `{ index, lower, upper }` for the offending
dimension, with the executing POU, instance path and index-expression span. The
index uses a decimal string to preserve 64-bit values. Constant out-of-bounds
indices, invalid bounds and excessive array sizes are compile-time
`type.invalid-constant` diagnostics instead.

Array access uses `type.not-array`, `type.array-index-count` or
`type.array-index-not-integer` for type and dimension mistakes. An array
declaration initialized without `[...]` uses `type.array-initializer-required`.
Bit access on an array-valued element uses `type.invalid-bit-access` with that
array descriptor. These errors do not also report `type.invalid-constant`.

## Structure member declarations

`decl.structure-member-type` (`{ name: string }`) reports a function block type
used directly or inside arrays at any nesting depth as a structure member.
`name` retains the innermost standard or user function block type's source
spelling; the diagnostic span covers the member's full type. Function block
instances cannot be structure members under ADR 0015.

## Function block array declaration restrictions

`decl.fb-array-form` (`{ form: "named" | "nested" }`) explains unsupported
instance-array declarations. Named instance-array types use `form: "named"` on
the element type name; nested instance arrays use `form: "nested"` on the array
type. Each rejected declaration reports the restriction once. Direct inline
multidimensional instance arrays remain supported.

Indexing a scalar function block instance uses `type.not-array` with a
`functionBlock` descriptor naming the actual block, rather than a scalar
placeholder type.

## Reference diagnostics

| Code                            | Meaning                                                                                        | Arguments |
| ------------------------------- | ---------------------------------------------------------------------------------------------- | --------- |
| `type.invalid-reference-target` | REF requires persistent mutable variable storage, or the reference operation/target is invalid | None      |
| `type.reference-initializer`    | A reference initializer must be NULL                                                           | None      |
| `runtime.null-reference`        | Postfix dereference of NULL                                                                    | None      |

Reference assignments and comparisons also use `type.assign-mismatch` and
`type.operand-mismatch` with reference descriptors. NULL faults name the executing
POU and the instance path when inside a function block.

## Type cycles and subrange FOR variables

`decl.type-cycle` (`{ name: string }`) identifies a direct or indirect containment
cycle through structures or arrays, or an alias cycle, at the declaration name
where resolution detects it. The cycle is reported once; involved declarations
do not also report `type.invalid-constant` or `decl.unknown-type`. Recursive links
through `REF_TO` are allowed because references do not contain their targets.

`type.for-variable-subrange` (`{ name: string; type: TypeDescriptor }`) explains
that a named or inline subrange cannot be a FOR control variable under ADR 0015.
It spans the variable in the FOR header and includes its name and declared type.
Use an unrestricted integer variable instead. Other non-integer control
variables retain `type.for-variable-not-integer`.

## Configuration sources

Configuration compiler diagnostics use `sourceKind: "configuration"` and
`sourceIndex: 0`. The `pou` field names the configuration when known. Runtime
faults from configurations also carry `task`; qualified instance paths identify
program and nested block storage.

| Code                         | Arguments      | Meaning                                                                                               |
| ---------------------------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| `config.configuration-count` | `{}`           | More than one configuration source declaration.                                                       |
| `config.resource-count`      | `{}`           | Exactly one resource is required.                                                                     |
| `config.task-count`          | `{}`           | A resource requires 1–16 tasks.                                                                       |
| `config.no-instances`        | `{}`           | A resource needs at least one program instance.                                                       |
| `config.instance-limit`      | `{}`           | More than 64 instances.                                                                               |
| `config.name-collision`      | `name: string` | Duplicate configuration/resource/task/instance/global name or collision with POU/type/standard names. |
| `config.unknown-task`        | `name: string` | Instance references an unknown task.                                                                  |
| `config.missing-task`        | `name: string` | Instance omits `WITH` and a task.                                                                     |
| `config.program-type`        | `name: string` | Instance type is unknown or is not a PROGRAM.                                                         |
| `config.interval`            | `{}`           | Nonliteral interval, outside 10 ms–1 h, or not a whole multiple of 10 ms.                             |
| `config.priority`            | `{}`           | Missing/noninteger priority or outside 0–65535.                                                       |
| `config.task-parameter`      | `name: string` | Duplicate or unsupported task parameter.                                                              |
| `config.task-trigger`        | `{}`           | Both or neither of INTERVAL and SINGLE.                                                               |
| `config.single`              | `{}`           | SINGLE is not a non-constant BOOL global or supported %IX input bit.                                  |
| `runtime.configured-cycle`   | `{}`           | Nonfatal `setCycle` rejection while an explicit configuration is loaded.                              |

`pou.program-count` still reports `found` when no configuration source is supplied.
Its localized message explains that a configuration source is needed to run several
PROGRAMs. `setCycle` joins `force` and `write` in rejection messages' `command` field.

## Global binding diagnostics

| Code                          | Arguments      | Meaning                                                  |
| ----------------------------- | -------------- | -------------------------------------------------------- |
| `global.not-found`            | `name: string` | No configuration/resource global matches an external.    |
| `global.type-mismatch`        | `name: string` | External and global types differ (string lengths aside). |
| `global.constant-mismatch`    | `name: string` | External and global CONSTANT qualifiers differ.          |
| `global.external-initializer` | `name: string` | An external declares an initializer or direct address.   |

`config.name-collision` includes global names in the shared configuration namespace.
`decl.duplicate` covers local/external duplicates. `pou.invalid-section` rejects
FUNCTION externals, and `decl.constant-not-writable` rejects stores to imported
constants. Global declaration errors identify the configuration source; binding
errors identify the importing POU and its source span.

### PROGRAM connection diagnostics

All of these carry the configuration name in `pou`, `sourceKind: "configuration"`,
`sourceIndex: 0`, and the offending parameter's span.

| Code                          | Arguments      | Meaning                                                                                                       |
| ----------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------- |
| `config.connection-parameter` | `name: string` | Unknown parameter or a declaration that is not an input/output/interface in-out.                              |
| `config.connection-direction` | `name: string` | Input or in-out uses `=>`, or output uses `:=`.                                                               |
| `config.connection-duplicate` | `name: string` | A parameter is connected more than once (case-insensitive).                                                   |
| `config.connection-target`    | `name: string` | Source is not a constant/global/address, or output targets a constant, input-mapped global, or input address. |

Connection type mismatches reuse `type.assign-mismatch` and constant diagnostics;
address errors reuse `decl.direct-address-type` and `decl.address-out-of-range`.
These also identify the configuration source and the connection value's span.
PROGRAM interface in-outs require mutable global storage (`config.connection-target`)
and an exact type (`call.in-out-type`). Missing bindings report
`call.missing-in-out` at the configured instance, or at the parameter declaration
under the implicit configuration.

`runtime.write-connected-input` (`{ name: string }`) rejects one-shot monitor writes
to a connected PROGRAM input. It is a command rejection; forces remain allowed.

`decl.output-overlap` is a warning with `{ address: string; other: string }` when
located declarations or direct output connections write overlapping Q bits. I/M
overlap is permitted without a warning. `decl.address-out-of-range` covers the
64-byte I/Q and 1,024-byte M boundaries, and bit indices outside 0–7.
`runtime.invalid-value` also covers reads of non-finite REAL/LREAL views; snapshots
use `invalidReal` and do not emit this diagnostic by themselves.

## Retention qualifier errors

All five codes have no arguments and severity error:

| Code                      | Condition                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `decl.retention-conflict` | RETAIN and NON_RETAIN on one section                                               |
| `decl.retention-section`  | Either qualifier on VAR_TEMP, VAR_IN_OUT or VAR_EXTERNAL                           |
| `decl.retention-function` | Either qualifier in a FUNCTION                                                     |
| `decl.retention-constant` | Either qualifier combined with CONSTANT                                            |
| `decl.retention-address`  | Either qualifier combined with AT or a direct-address PROGRAM parameter connection |

Section errors point to the section; address errors point to the address.
Configuration errors retain configuration source identity. Restore mismatches and
storage failures are UI warnings rather than PLC faults; skipped paths arrive in
the retentiveRestored event.

## Method diagnostics

| Code                     | Arguments | Meaning                                        |
| ------------------------ | --------- | ---------------------------------------------- |
| `access.duplicate`       | None      | Two access specifiers on one method or section |
| `access.invalid-section` | None      | Access on a section other than block `VAR`     |
| `access.hidden`          | `name`    | Method hidden from the calling type            |
| `method.invalid-owner`   | None      | METHOD in PROGRAM or FUNCTION                  |
| `method.name-collision`  | `name`    | Duplicate method, member clash or local shadow |
| `method.unknown`         | `name`    | Receiver has no such method                    |
| `method.instance-in-out` | `name`    | Instance VAR_IN_OUT used from a method         |
| `method.this-outside`    | None      | THIS without a block instance context          |
| `method.this-call`       | None      | Attempt to call the instance body through THIS |

Inaccessible data members retain `fb.unknown-member`. Method parameters, section
restrictions, missing results, assignment types and recursion reuse function/POU
codes. Runtime faults use `Type.Method` in `pou`, retain a span in the owning block
text and include `instance` when the receiver path is known.

## Class diagnostics

| Code                 | Arguments | Meaning                                                   |
| -------------------- | --------- | --------------------------------------------------------- |
| `class.body`         | None      | Statements outside a class method                         |
| `class.not-callable` | `name`    | Calling a class instance body, including an array element |

Class sections reuse `pou.invalid-section` with kind `"class"`; AT reuses
`pou.direct-address`. Instance placement, constants, initializers and structure
members reuse `fb.invalid-instance-section`, `pou.function-block-in-function`,
`decl.constant-type`, `decl.fb-initializer` and `decl.structure-member-type`.
Hidden data members reuse `fb.unknown-member`, and hidden methods use
`access.hidden`. Containment and call cycles use `pou.recursion`. A variable named
like a class uses `decl.name-collision` with kind `"type"`.

## Inheritance (ADR 0017)

| Code                                 | Arguments | Meaning                                                           |
| ------------------------------------ | --------- | ----------------------------------------------------------------- |
| `inheritance.unknown-base`           | `name`    | Base type is unknown                                              |
| `inheritance.base-kind`              | `name`    | Base and derived kinds differ                                     |
| `inheritance.cycle`                  | `name`    | Base graph contains a cycle                                       |
| `inheritance.final-base`             | `name`    | Extending a FINAL type                                            |
| `inheritance.member-collision`       | `name`    | Redeclaring an inherited variable or a variable/method collision  |
| `inheritance.override-required`      | `name`    | Inherited method redeclared without OVERRIDE                      |
| `inheritance.override-missing`       | `name`    | OVERRIDE has no inherited method                                  |
| `inheritance.override-private`       | `name`    | Overriding a PRIVATE method                                       |
| `inheritance.override-final`         | `name`    | Overriding a FINAL method                                         |
| `inheritance.override-access`        | `name`    | Override changes access                                           |
| `inheritance.override-signature`     | `name`    | Override changes parameters or result                             |
| `inheritance.abstract-instance`      | `name`    | Instantiating an ABSTRACT type                                    |
| `inheritance.abstract-method`        | `name`    | Abstract method has statements or belongs to a concrete type      |
| `inheritance.abstract-private`       | `name`    | Abstract method is PRIVATE                                        |
| `inheritance.abstract-unimplemented` | `name`    | Concrete type leaves an abstract method unimplemented             |
| `inheritance.abstract-body`          | None      | Abstract function block has body statements                       |
| `inheritance.modifier-conflict`      | None      | Conflicting/repeated ABSTRACT or FINAL                            |
| `inheritance.super-context`          | None      | SUPER requires a derived type context                             |
| `inheritance.super-method`           | `name`    | Base method is missing, abstract or PRIVATE                       |
| `inheritance.super-body`             | None      | SUPER() has arguments or is outside a derived function block body |

Inherited access violations use `access.hidden` (or `fb.unknown-member` for external
member access). Dynamic cycles use `pou.recursion`, including cycles created by an
override calling SUPER into a base method that calls THIS back into the override.

## Interface diagnostics

| Code                           | Arguments | Meaning                                                                                                  |
| ------------------------------ | --------- | -------------------------------------------------------------------------------------------------------- |
| `interface.unknown`            | `name`    | EXTENDS or IMPLEMENTS does not name an interface.                                                        |
| `interface.cycle`              | `name`    | Interface EXTENDS forms a cycle.                                                                         |
| `interface.signature`          | `name`    | Inherited prototypes of the same name disagree.                                                          |
| `interface.unimplemented`      | `name`    | A concrete type lacks a PUBLIC concrete method of the required signature.                                |
| `interface.lifetime`           | none      | An instance assignment cannot guarantee persistent storage.                                              |
| `interface.assignment-attempt` | none      | Assignment attempt requires interface or user-instance reference operands (NULL is also a valid source). |

Interface variable use also reuses decl.unknown-type, decl.name-collision (kind
"type"), type.assign-mismatch, type.reference-initializer,
type.invalid-reference-target, method.unknown and pou.recursion. Invalid syntax,
including an assignment attempt inside an expression, uses syntax diagnostics. A
call through NULL reports runtime.null-reference.

## Instance reference diagnostics (ADR 0017)

`type.invalid-reference-target` rejects REF_TO a standard function block or an
interface and REF of storage without persistent lifetime. `type.assign-mismatch`
rejects an implicit base-to-derived reference assignment; `type.operand-mismatch`
rejects equality between unrelated reference targets. Access checks reuse
`access.hidden`, `fb.unknown-member` and `fb.output-not-writable`.
`interface.assignment-attempt` also covers invalid instance reference casts;
`pou.recursion` includes every possible derived method/body call. Dereferencing
NULL for a method, body, member or interface binding faults with
`runtime.null-reference`. A failed assignment attempt instead yields NULL.

## Namespaces

| Code                        | Arguments | Meaning                                                        |
| --------------------------- | --------- | -------------------------------------------------------------- |
| `namespace.unknown`         | `name`    | Unknown imported namespace or absolute qualified name.         |
| `namespace.ambiguous`       | `name`    | Multiple declarations match the import/global lookup stage.    |
| `namespace.internal`        | `name`    | An INTERNAL declaration is used outside its namespace subtree. |
| `namespace.internal-global` | `name`    | Declaration INTERNAL requires a namespace.                     |

Namespace root, namespace/declaration and standard simple-name collisions use
`decl.name-collision` with kind `type`. Existing access diagnostics cover INTERNAL
members and methods. Names of declarations and their types are qualified in
diagnostic POU context and name arguments.

## Halt command rejections

| Code                 | Arguments | Meaning                                                                                         |
| -------------------- | --------- | ----------------------------------------------------------------------------------------------- |
| `runtime.halted`     | `{}`      | Nonfatal rejection of `run`, `step` or `setCycle` while halted.                                 |
| `runtime.not-halted` | `{}`      | Nonfatal rejection of `continue` or `debugStep` while not halted (also when a step is pending). |

These codes use `rejected`, with the corresponding `command`, and never latch a
FAULT. Breakpoint and step halts use the separate `halted` event and reported HALT
state; `debugStep` is a possible rejected `command`.

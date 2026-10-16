# Semantic checking

`check(ast)` accepts the `Program` returned by `parse(source)`. It returns either
`{ checked: CheckedProgram, diagnostics: [] }` or `{ checked: null, diagnostics }`.
It collects semantic errors with source spans and never exposes a partially
checked program. Parsing remains separate; `compile(source)` and IR lowering are
issue #7.

The checked result retains the original AST without modifying it, plus:

- `symbols`: declaration order, original identifier, type and coerced initial
  value (scalar defaults are FALSE/zero; FB initialization is null).
- `expressions`: AST expression object to result type and optional constant value.
- `references`: AST identifier object to variable index and optional FB port/index.
  Declaration names, assignment targets, reads, FOR variables, FB instances and
  named inputs all use the same symbol IDs.
- `functions`: AST function-call object to canonical standard-function opcode.

These Maps are compiler-local side tables keyed by AST identity. They are not
serialized or sent to the runtime. The later lowering pass can use them to produce
the plain tree IR. Source spelling and spans stay in the AST.

## Rules

Names are matched by their parser-supplied upper-case keys, across all VAR blocks.
All declarations are collected before checking expressions. Initializers may use
literals, parentheses, unary operators and binary operators; variable references,
FB members and function calls are not constant expressions. CASE labels and range
endpoints must also be integer constant expressions. Constant values are coerced
at each operator, so integer division truncates toward zero and integer results
wrap to the expression's representation. Division by zero, non-finite constants,
and REAL overflow produce `type.invalid-constant` at the expression. Destination
coercion also checks representability. This evaluation validates initializers and
CASE labels; it does not replace AST expressions or optimize executable IR.

Assignment follows issue #6. Arithmetic returns REAL when either numeric operand
is REAL/LREAL, otherwise DINT when either is DINT, otherwise INT (including UINT
pairs). TIME supports addition/subtraction with TIME and multiplication/division
with a numeric right operand. Unary plus/minus support numeric types and TIME;
NOT supports BOOL and integers. Real-to-integer assignments include the existing
`explicit-conversion` hint identifier for the UI to localize.

## Standard signatures

The compiler-local signature table follows the milestone ports in
[core-contracts.md](core-contracts.md). Issue #9 should move descriptors to core
for sharing with the runtime; runtime implementations remain in runtime.
Omitted FB inputs retain their values. Provided inputs must be unique, writable
and assignable to the declared input type. Outputs may be read but never assigned,
including in a named-input call.

| Function    | Arguments                            | Result                                        |
| ----------- | ------------------------------------ | --------------------------------------------- |
| ABS         | One numeric value                    | Argument type                                 |
| MIN, MAX    | Two or more numeric values           | Numeric promotion across arguments            |
| LIMIT       | Three numeric values                 | Numeric promotion across arguments            |
| SEL         | BOOL selector, two compatible values | Numeric promotion, or matching BOOL/TIME type |
| REAL_TO_INT | One REAL                             | INT                                           |
| INT_TO_REAL | One INT                              | REAL                                          |
| TIME_TO_INT | One TIME                             | INT                                           |
| INT_TO_TIME | One INT                              | TIME                                          |
| BOOL_TO_INT | One BOOL                             | INT                                           |

Numeric promotion across multiple arguments uses the arithmetic rule above.
Conversion arguments match their declared source type exactly; assignment's
implicit integer/real widening does not apply to explicit conversions.

Diagnostics identify offending names, members, address tokens, expressions or
EXIT statements. The codes and argument shapes are in
[diagnostics.md](diagnostics.md). `type.case-label-not-constant`,
`type.invalid-constant` and `fb.duplicate-input` extend that catalog because the
existing codes could not represent those failures accurately.

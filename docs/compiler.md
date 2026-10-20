# Compiling Structured Text

`@benchtop-plc/compiler` exports `compile(source): CompileResult`. It runs the
[parser](compiler-parser.md), [semantic checker](type-checking.md) and IR lowering
in order. Success returns `{ ir: ProgramIR, diagnostics: [] }`. Failure returns
`{ diagnostics: Diagnostic[] }` with the `ir` property omitted; no partially valid
IR is exposed. Diagnostics retain the earlier stage's codes, arguments and spans.

`lower(checked): ProgramIR` is also available for callers that already have a
successful `check(ast)` result. It expects the AST and its semantic side tables
to remain intact. It produces a fresh plain-data tree without mutating or sharing
mutable objects with the AST. Maps, source identifier objects and unneeded parser
fields never appear in the IR.

## Representation

The IR follows [core-contracts.md](core-contracts.md). Declarations stay in source
order; names in a grouped declaration become separate variables with the same
declaration span. Scalar initializers/defaults come from the checker's coerced
values. BOOL addresses are copied only when present. FB initial values are null.
Variable references, FB members, named FB inputs and function calls use their
resolved IDs, port indices and canonical opcodes, with explicit expression types.

Untyped constants are evaluated exactly and materialized as one literal of the
position's type (see [type-checking.md](type-checking.md)). This prevents premature
wrapping or real rounding inside an untyped expression. Typed operators remain in
the executable tree and use their checked type at every step. REAL literals are
already binary32; LREAL literals are binary64. TIME literals contain integer
milliseconds. Initializers and CASE constants are evaluated during checking.

Every IR node has a one-based, end-exclusive source span. Parentheses have no IR
node, so the enclosed root receives the complete parenthesized span and descendants
keep their original spans. An omitted FOR step becomes a literal 1 of the control variable's type located
at the loop variable token, giving the synthetic node a meaningful source span.

Each assignment and FB call retains the whole statement's span. Its `span.line`
is the annotation line; `span.column` distinguishes multiple statements on a line.
Multiline FB calls use the line containing the instance name. This follows the
runtime protocol without a separate annotation table or redundant line property.

## Verification

`tests/conformance/fixtures/reference-ir.json` is the checked-in compiler golden
for `reference.st`. Conformance tests compare the entire IR, walk every node's
span and check JSON/structured-clone transport and annotation locations. The
existing hand-written `reference-ir.ts` remains an independent core contract
fixture; grouped expression spans now include their parentheses in compiled IR.
The interpreter acceptance test is TODO until runtime issue #8 is merged.

# Compiling Structured Text

`@benchtop-plc/compiler` exports `compile(source): CompileResult` for existing
single-program callers and `compileProject(sources: readonly string[]): CompileResult`
for an ordered list of POU texts, each containing exactly one declaration. It runs the
[parser](compiler-parser.md), [semantic checker](type-checking.md) and IR lowering
in order. Success returns `{ ir: ProgramIR, diagnostics }`, with any portability warnings. Failure returns
`{ diagnostics: CompileDiagnostic[] }` with the `ir` property omitted; no partially valid
IR is exposed. Diagnostics retain the earlier stage's codes, arguments and spans,
and carry the source POU name in `pou` when its header is known. Every `compileProject` diagnostic
belonging to a POU also carries a zero-based `sourceIndex` into the input list,
including lexer errors and diagnostics for duplicated names. Project-level
program-count errors omit `pou`, `sourceIndex` and `span`. The single-source
`compile` entry point preserves its existing diagnostic shape without `sourceIndex`.

A project requires exactly one `PROGRAM`. `parsePou(source)` parses a `PROGRAM` or
`FUNCTION` or `FUNCTION_BLOCK`; `parse(source)` remains the single-program parser.
Project-wide compilation collects signatures before checking any bodies, so forward
calls work, and checks function calls and block containment for direct or indirect recursion.
See [ADR 0014](adr/0014-user-defined-pous.md). The web editor manages the ordered POU list and PLCopen XML preserves each text.

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

## User functions

`ProgramIR.functions` contains each function body once, in project function order.
A `userFunctionCall` references that table by index; its inputs retain source
evaluation order and use resolved local variable indices. Outputs likewise bind a
callee local index to a writable caller target. Each definition has its own local
variable table, input/output indices and optional result variable index. A result
variable is appended after declared locals and starts at the result type's default.
An expression call has an elementary `dataType`; a no-result statement call has
`dataType: null`. Standard functions retain their opcode representation; formal
calls include `evaluationOrder` when signature order differs from source order.

## User function blocks and storage

`ProgramIR.functionBlocks` holds each block body once. `userFbCall.variable` selects
an instance slot in the caller's frame, and `userFbMember` selects a public scalar
input/output by its declaration slot in that instance. User and standard FB calls
support named `:=` inputs and `=>` output bindings, with assignment widening.

`ProgramIR.variables` is the flat monitored storage table: program scalars and
standard FBs, plus every persistent scalar or standard FB below a user instance.
Nested entries use canonical dotted names, such as `M1.RUNNING` and `M1.DELAY`.
`storage` maps PROGRAM declaration slots to those VariableIds, temporary scalar
initial values or indices into `instances`. Each instance records its block index,
path and the same storage mapping for its own declaration slots. No code is copied
while allocating the instance tree. PROGRAM and block `VAR_TEMP` declarations have
frame slots but no monitored identity.

## Verification

`tests/conformance/fixtures/reference-ir.json` is the checked-in compiler golden
for `reference.st`. Conformance tests compare the entire IR, walk every node's
span and check JSON/structured-clone transport and annotation locations. The
existing hand-written `reference-ir.ts` remains an independent core contract
fixture; grouped expression spans now include their parentheses in compiled IR.
Multi-source traces and `user-functions.test.ts` cover user-function execution
and checking, including fresh locals, formal defaults, outputs, nested calls,
fault attribution and the shared scan watchdog.

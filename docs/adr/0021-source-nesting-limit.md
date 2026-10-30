# 0021. Limit syntactic source nesting

- Status: Accepted
- Date: 2026-10-31
- Related: [0002](0002-tree-shaped-ir-as-plain-data.md),
  [0006](0006-plcopen-xml-project-format.md),
  [0015](0015-derived-types-strings-and-references.md)
- Source: [issue #218](https://github.com/yasukei/benchtop-plc/issues/218)

## Context

Deeply nested ST can exhaust the JavaScript stack during parsing, checking,
lowering, execution or project exchange. In particular, restoring such source
from autosave can prevent the editor from starting. Making just the parser
iterative would leave the later recursive stages exposed.

## Decision

Accept at most **32 levels of syntactic nesting** along any path in one source.
This is an implementation restriction, like the array-size restriction in
ADR 0015. The compiler returns `syntax.nesting-limit` with `{ limit: 32 }` for
deeper source, with English and Japanese messages.

Each group, unary operator, call, aggregate initializer, compound statement
(`IF`, `CASE`, `FOR`, `WHILE`, `REPEAT`), anonymous `ARRAY` or `REF_TO` adds one
level. A flat binary operator chain or member/index/dereference access chain
counts as one syntax level. Only continuation along the operator's left operand
or the accessed object stays in that chain; right operands and index expressions
start their own paths. Levels compose: 16 nested `IF`s may contain 16
parenthesized groups. Literal/name leaves, assignments, source and
variable-section containers, branch lists and sibling statements add no levels.
Declaration type and initializer paths are counted separately.

Independently cap the total recursive syntax-tree depth at **256 levels**,
counting every operator/access node as well as the nesting forms above. Return
`syntax.tree-depth-limit` with `{ limit: 256 }` when that bound is exceeded. The
cap is shared along the entire path, so nesting several flat chains cannot
multiply the allowed recursion. This permits ordinary flat sums and alarm/interlock
expressions beyond 32 operators, while still protecting recursive AST consumers.

Both source-limit diagnostics survive project import, instead of becoming a
misleading `project.invalid` error about the POU interface. Failed operands are
tracked separately from deferred ones during contextual type checking, so an
invalid nested enumeration expression is checked once rather than doubling work
and diagnostics at every level.

Guard recursive descent before entering nested syntax. Also inspect the raw AST
iteratively before returning it, because parser loops build deep trees for flat
operator and access chains. Apply the same checks to configuration expressions
and declarations. The bound therefore protects all subsequent recursive stages,
including project canonicalization and XML writing. The XML reader's existing
128-element limit protects structural XML recursion before reconstructed ST is
parsed with the source limit.

Choose 32 conservatively rather than measuring a host's stack-exhaustion point.
Each recursively nested aggregate type or initializer can require several XML
elements; 32 leaves room for expansion and project structure within the XML
reader's 128-element limit. Operator and access chains remain ST text in XML,
so that XML multiplier does not apply to them. Choose the separate tree cap of
256 to leave room for ordinary flat expressions while limiting the JavaScript
frames consumed by recursive checking, lowering and execution. Conformance tests
cover the accepted boundary and first rejected level for expressions, statements, types and initializers.
A Playwright test bundles the compiler, runtime and project codec into a Chromium
Worker and verifies compilation, one scan, XML writing, reading and recompilation
at both boundaries, including 256-level sums, Boolean OR chains and access paths.
Tests also cover 34-term expressions, mixed nesting/tree budgets and invalid
operands at accepted depths. These tests justify the chosen limit without assuming
Node's stack size represents the browser's. Raising it requires updating that evidence.

## Consequences

- Very deep source now returns a diagnostic instead of escaping with a stack
  overflow, including when restored from autosave.
- Flat operator/access chains consume the separate 256-level tree budget;
  users may split expressions beyond that cap into statements or intermediate
  values. Both limits are documented for users and have distinct diagnostics.
- This counts syntax in each source, not resolved dependencies. It introduces no
  language depth limit on acyclic function block instance hierarchies or named
  type hierarchies, and does not change the statement in `docs/compliance.md`.
- The tree-shaped AST and IR and the later recursive implementations remain in
  place. This restriction does not promise to bound total source size or memory.

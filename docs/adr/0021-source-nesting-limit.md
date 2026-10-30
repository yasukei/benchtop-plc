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

Each group, unary or binary operator, call, member/index/dereference access,
aggregate initializer, compound statement (`IF`, `CASE`, `FOR`, `WHILE`, `REPEAT`),
anonymous `ARRAY` or `REF_TO` adds one level. Levels compose: 16 nested `IF`s may
contain 16 parenthesized groups. Literal/name leaves, assignments, source and
variable-section containers, branch lists and sibling statements add no levels.
Declaration type and initializer paths are counted separately.

Guard recursive descent before entering nested syntax. Also inspect the raw AST
iteratively before returning it, because parser loops build deep trees for flat
operator and access chains. Apply the same checks to configuration expressions
and declarations. The bound therefore protects all subsequent recursive stages,
including project canonicalization and XML writing. The XML reader's existing
128-element limit protects structural XML recursion before reconstructed ST is
parsed with the source limit.

Choose 32 conservatively rather than measuring a host's stack-exhaustion point.
Every syntax level can require several JavaScript frames or XML elements; 32
leaves room for these multipliers and the surrounding project structure within
the XML reader's 128-element limit. Conformance tests cover the accepted boundary
and first rejected level for expressions, statements, types and initializers.
A Playwright test bundles the compiler, runtime and project codec into a Chromium
Worker and verifies compilation, one scan, XML writing, reading and recompilation
at the boundary. These tests justify the chosen limit without assuming Node's
stack size represents the browser's. Raising it requires updating that evidence.

## Consequences

- Very deep source now returns a diagnostic instead of escaping with a stack
  overflow, including when restored from autosave.
- Long flat operator/access chains also consume the tree budget; users may split
  them into statements or intermediate values.
- This counts syntax in each source, not resolved dependencies. It introduces no
  language depth limit on acyclic function block instance hierarchies or named
  type hierarchies, and does not change the statement in `docs/compliance.md`.
- The tree-shaped AST and IR and the later recursive implementations remain in
  place. This restriction does not promise to bound total source size or memory.

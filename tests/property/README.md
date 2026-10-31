# Frontend property tests

`pnpm test` includes these fast-check properties. Run only this suite with:

```sh
pnpm test tests/property
```

Each property runs 100 cases with seed `246`, including in CI, and has a 10-second
fast-check time budget, allowing headroom for coverage instrumentation and parallel
test workers. An interrupted run fails rather than silently passing.
Inputs are bounded too: 256 code units of arbitrary text, 64 generated ST tokens,
up to four edits of corpus inputs, nesting depths up to 4,096, and up to eight
statements per generated project. The time budget is checked between synchronous
cases and shrinking steps; it cannot preempt a frontend call that hangs.

The corpus discovers sorted ST files under `tests/conformance/` and `examples/`,
plus all bundled example XML files and XML serialized from the reference ST
fixture. ST project mutations keep the other POUs, data types and configuration
in place. Character mutations insert, delete, replace or duplicate spans;
generated token streams use the corpus vocabulary. A separate mutation branch
replaces one identifier or literal token with another of the same lexical kind
from the corpus, keeping keywords and punctuation intact so more inputs reach
semantic checks. The compiler property mixes arbitrary ST, character-mutated
projects and token-mutated projects with equal weights; syntax errors are still
expected, and preserving companion sources does not guarantee valid syntax.
Separate generated projects exercise aliases, arrays, functions, conditionals,
implicit/explicit configurations, LF/CRLF source, XML escaping, Unicode and panel
JSON. They must compile before serialization; the tests compare all project fields
and recompiled IR after reopening, without filtering out rejected projects.

The mutated XML property checks the public `readProject` contract: every call
returns a project or diagnostics without an exception escaping. The reader catches
unexpected internal errors, including `TypeError` and `RangeError`, and converts
them to `project.invalid-xml`. This property cannot distinguish those errors from
ordinary XML rejection, so a passing run is not evidence that the reader's
internals never crash. The generated-project round-trip property additionally
requires successful imports and detects errors that reject its valid projects.
Detecting unexpected errors on rejected XML would require separate internal error
observability, beyond the public-contract tests in #246.

For a longer local run, increase both the case count and the per-property budget.
Choose another seed to explore different inputs:

```sh
FC_NUM_RUNS=1000 FC_TIME_LIMIT_MS=30000 FC_SEED=20261031 pnpm test tests/property
```

Failures print the seed, replay path and shrunk counterexample. Use the reported
values and select the failing test to replay it:

```sh
FC_SEED=246 FC_PATH='0:1' pnpm test tests/property -t 'generated nesting depths'
```

For example, temporarily raising `MAX_SOURCE_NESTING` from `32` to `1000000` in
`packages/compiler/src/nesting.ts` produced this report on Node 26.13.0:

```text
Property failed after 1 tests
{ seed: 246, path: "0:1", endOnFailure: true }
Counterexample: [2048]
Shrunk 1 time(s)
Caused by: RangeError: Maximum call stack size exceeded
```

The counterexample is the number of nested parentheses, rendered by `sourceAtDepth`.
The stack-overflow threshold can vary with the engine and instrumentation. Restore
the guard after this demonstration; the checked-in suite passes with it enabled.

If a property discovers a new defect, open a bug with the seed, path and input, and
keep the minimized counterexample as a regular regression test. Defect fixes belong
in that bug's PR, as required by #246.

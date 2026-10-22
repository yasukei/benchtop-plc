# 0014. User-defined POUs, calls and instances

- Status: Accepted
- Date: 2026-10-22
- Related: [0002](0002-tree-shaped-ir-as-plain-data.md),
  [0006](0006-plcopen-xml-project-format.md),
  [0010](0010-operating-states-restarts-and-runtime-errors.md),
  [0012](0012-elementary-data-types.md),
  [0013](0013-conversions-literals-and-operators.md)
- Source: [issue #94](https://github.com/yasukei/benchtop-plc/issues/94)

## Context

Milestone 4 adds user-defined functions and function blocks to the single-program
project. ADR 0010 defines scan and restart behavior, ADR 0012 defines values and
constant arithmetic, and ADR 0013 defines conversions and contextual typing. They
do not define parameter passing, memory between calls or instance addressing.
The compiler, runtime, project codec and web app need one model before the
implementation issues under [#93](https://github.com/yasukei/benchtop-plc/issues/93)
can proceed.

As in ADR 0012, the 4th edition text (IEC 61131-3:2025) was not available when this
ADR was written. Decisions that depend on the standard follow the 3rd edition
text and secondary sources; they are not verified claims about 4th edition
clauses. The checks and project restrictions below are tracked in
[#92](https://github.com/yasukei/benchtop-plc/issues/92).

## Decision

### Project model

- A project is an ordered list of POUs. Each POU is edited as its own ST text containing
  exactly one `PROGRAM`, `FUNCTION` or `FUNCTION_BLOCK` declaration.
- A project has exactly one `PROGRAM`, bound to the single cyclic task as today. Several
  programs and tasks come with Milestone 6. A `PROGRAM` cannot be called or instantiated
  from another POU.
- POU names share one case-insensitive namespace with each other and with every standard
  name: standard functions including conversion, `TRUNC_*` and BCD forms, standard
  function blocks including the typed names (`TON_LTIME`, `CTU_DINT`), and elementary
  type names. Keywords are reserved as today. A duplicate POU name or a clash with a
  standard name is a compile error. A variable whose name equals a POU name is
  `decl.name-collision` with the existing kinds: `"function"` for a user function,
  `"type"` for a user function block or the `PROGRAM`, as for elementary types and
  standard FBs today. No new kind is added.
- The compiler compiles all POUs of a project together. Each diagnostic names the POU it
  belongs to as well as its span. Project-level errors (no `PROGRAM`, more than one)
  name no POU; a duplicate POU name is reported on the later POU.

### Sections per POU kind

- `PROGRAM`: `VAR` (with `CONSTANT` and `AT`) and `VAR_TEMP`, which starts from its
  initial values on every scan. `VAR_INPUT`, `VAR_OUTPUT` and `VAR_IN_OUT` in a
  `PROGRAM` are compile errors in this milestone (restriction; a program cannot be
  called yet).
- `FUNCTION`: `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT` and `VAR` (with `CONSTANT`).
  `VAR_TEMP` and function block instances are compile errors (restrictions).
- `FUNCTION_BLOCK`: `VAR_INPUT`, `VAR_OUTPUT`, `VAR_IN_OUT`, `VAR` (with `CONSTANT`) and `VAR_TEMP`.

### Saving, opening and running

- Run requires a project without compile errors, as today.
- Saving to PLCopen XML (TC6 v2.01, [ADR 0006](0006-plcopen-xml-project-format.md); each
  POU one `<pou>`; IEC 61131-10 is reconsidered in Milestone 7) requires what the file
  format needs and nothing more: every POU text parses into a header, declarations and a
  body, and each initializer passes the existing checks in the context of its POU:
  `CONSTANT`s declared earlier in the same POU are in scope, a name that resolves to
  nothing is a semantic error that does not block (as an unknown type already is), and a
  value that does not fit its type blocks. Semantic errors (unknown calls, duplicate
  names, name clashes, recursion, zero or several `PROGRAM`s) do not block saving; they
  appear again as diagnostics after opening. A text that does not parse cannot be saved,
  as today; it is kept by autosave only.
- Opening rejects only what the file cannot represent: XML structure, an unsupported
  `pouType` or variable section, and initializers that fail the same check as saving.
  Every file the app saves opens again with the same POU texts.
- The task's `pouInstance` names the first `PROGRAM` in project order. With no `PROGRAM`
  the task has no `pouInstance`. On open, a `pouInstance` must name a `PROGRAM` of the
  file.

### Functions

- `FUNCTION name : type` returns the value last assigned to the function name, or the
  type's default if none was assigned. Inside the body the function name is read and
  written like a local variable. A function without a result type can only be called as
  a statement.
- A function has no memory between calls: `VAR`, `VAR_OUTPUT` and the result start from
  their initial values on every call.
- Calls are formal (`F(A := x, Q => y)`) or non-formal (`F(x, y)`), never mixed. In a
  formal call to a user function an omitted input takes its declared initial value;
  standard functions keep requiring every input (`call.argument-count`). A non-formal
  call is allowed only for functions whose parameters are all `VAR_INPUT` and must
  supply exactly one argument per input, in declaration order.
- Arguments follow ADR 0013: untyped constants take the parameter type (rule 2), inputs
  accept implicit widening only, and `=>` follows the implicit conversion rules of
  assignments. `VAR_IN_OUT` has no implicit conversion.

### Function blocks

- Each instance has its own copy of `VAR_INPUT`, `VAR_OUTPUT` and `VAR`, kept between
  calls. `VAR_TEMP` starts from its initial values on every call.
- Instances can be declared in the `VAR` section of a `PROGRAM` or a `FUNCTION_BLOCK`.
  Nesting is unlimited, but a block cannot contain itself directly or indirectly.
- FB calls stay formal only: `inst(IN := x, Q => y)`. An input that is not supplied
  keeps its previous value. `=>` copies an output after the call; it also works for
  standard function blocks.
- Outside the block, `inst.Q` reads an output and `inst.IN` reads or assigns an input,
  as for standard FBs today. `VAR`, `VAR_TEMP` and `VAR_IN_OUT` members are not
  accessible from outside.

### Common rules

- `VAR_IN_OUT` passes a reference and is an ordinary alias of the actual variable. The
  actual parameter must be a variable of exactly the declared type: a variable of the
  caller, including the caller's own `VAR_INPUT`, `VAR_OUTPUT` or `VAR_IN_OUT`.
  Expressions, constants, bit access and `inst.X` members are compile errors. It must be
  supplied in every call. The same variable may be passed to two in-outs, or to an
  in-out and an input, of one call.
- Forces keep the existing stages (ADR 0010, [runtime contract](../runtime.md)): they
  are applied to the actual variable before and after execution, and an in-out does not
  add read-level forcing. With `x` forced to 10, an increment through an in-out followed
  by `seen := x` gives `seen = 11`, and `x` is 10 again after the scan.
- Operands and arguments are evaluated left to right, so `F(N := x) + x`, with `N` a
  `VAR_IN_OUT` of `F`, is deterministic when `F` changes `x`.
- Recursion, direct or indirect, through functions or function blocks, is a compile error.
- `RETURN` leaves the current POU.
- Direct addresses (`AT %IX…`) are allowed only in the `PROGRAM` (restriction).

### Constants

- `CONSTANT` is allowed on `VAR` sections of every POU kind, not on other sections, and
  not together with `AT`. It applies to elementary types only; an FB instance in `VAR
CONSTANT` is a compile error. An initializer is optional; without one the type's
  default applies.
- A constant counts as a typed constant under ADR 0012: its initializer is
  range-checked, and arithmetic on it wraps like run-time arithmetic of its type. It may
  appear wherever ADR 0013 requires or accepts a constant: initializers of later
  declarations, `CASE` labels, the bit index of `x.n`, `FOR` bounds and step.
- A constant's initializer may refer only to constants declared earlier in the same POU;
  a self, forward or cyclic reference is a compile error.
- Constants are folded at compile time and get no `VariableId`, in the `PROGRAM` as in
  blocks: they do not appear in the monitor, so writes and forces on them cannot be
  expressed. Assigning a constant, or passing it to `=>` or `VAR_IN_OUT`, is a compile
  error.

### Instance memory, restarts and faults

- Function and function block bodies appear once in the IR; instances do not duplicate code.
- Load and cold reset initialize the whole instance tree, nested instances and the
  private state of standard FBs (timer start, previous `CU`, first-call flag of
  `R_TRIG`) included. STOP → RUN, single scan and FAULT keep it (ADR 0010). Function
  variables and `VAR_TEMP` are neither in snapshots nor in this initialization.
- A run-time fault names the POU where it occurred and, when it occurred inside a
  function block instance, the instance path (`MOTOR1.STARTDELAY`), so the span is shown
  in the right text.
- ADR 0010's limit of 200,000 loop iterations counts per scan across all POUs, not per call.

### Monitoring

- Every scalar `VAR_INPUT`, `VAR_OUTPUT` and non-`CONSTANT` `VAR` member of a user FB
  instance reachable from the program gets its own `VariableId`, with a dotted path such
  as `MOTOR1.RUNNING` as its display name. `VAR_IN_OUT` members get none; the caller's
  actual variable is monitored, written and forced under its own ID.
- A standard FB instance keeps today's representation wherever it is nested: one
  `VariableId` (`MOTOR1.STARTDELAY`), `FunctionBlockMemberReference` for its ports and
  the `{ kind: "functionBlock"; inputs; outputs }` snapshot. Its private state is not
  exposed.
- Snapshots, writes and forces keep addressing variables by `VariableId`.
- Inline values are shown only in the `PROGRAM` body in this milestone. A user FB call
  there shows its `VAR_OUTPUT`s in declaration order, like a standard FB call. A
  function called as a statement shows its result, as a standard function does today; a
  function without a result shows nothing, and function `VAR_OUTPUT`s are not shown
  (their `=>` targets are in the monitor). Choosing an instance to show values inside a
  block body belongs to debugging (Milestone 8).

### Overloaded standard timers and counters

- An instance declared as `TON`, `TOF` or `TP`, or as `CTU`, `CTD` or `CTUD`, takes its
  variant from the types bound to `PT` or `PV` in calls and in assignments to `inst.PT`
  / `inst.PV` within the declaring POU. Take the ADR 0013 common type of all selecting
  bindings, then pick the variant: TIME → `_TIME`, LTIME → `_LTIME`; for counters the
  first of `_INT`, `_DINT`, `_UDINT`, `_LINT`, `_ULINT` the common type converts to
  implicitly (UINT → `_DINT`, INT with UDINT → LINT → `_LINT`). Selecting types without
  a common type, or with no matching variant (BYTE, REAL, BOOL), are compile errors.
- A binding selects only if its type is known without inference. Untyped constants do
  not select, and neither does an expression that reads any member (`PT`, `PV`, `ET`,
  `CV`) of another instance whose variant is itself being selected (`a(PV := b.CV)`,
  `a(PV := b.PV)`, `b.ET + T#1s`). Selection therefore needs no iteration and does not
  depend on statement or declaration order.
- An instance without a selecting binding keeps today's TIME or INT behaviour. After
  selection every binding is checked against the selected variant like an ordinary
  argument, and untyped constants are typed by it (ADR 0013 rule 2). So `c(PV :=
100000)` alone is `type.invalid-constant` against INT; `a(PV := b.CV); b(PV := a.CV);`
  resolves both to `_INT` and compiles; `a(PV := b.CV); b(PV := DINT#100);` selects
  `_DINT` for `b`, keeps `a` at `_INT` and reports the DINT → INT narrowing on `a`'s
  binding, which the user resolves with `a : CTU_DINT`.
- Outputs (`ET`, `CV`, `=>` targets) never select their own instance. A user who needs a
  variant without a typed `PT`/`PV` declares the typed name (`CTU_DINT`, `TON_LTIME`);
  the language documentation must state this.
- The selection is per declaration, so all instances of a declaring function block share
  it. The monitor and hover show the selected name (`CTU_DINT`).
- This is a deliberate, POU-local exception to ADR 0013's rule that types do not flow
  from use to declaration; the checker needs a pass over the whole POU before checking.

### Restrictions and points to check

The following decisions are based on the 3rd edition and need verification against
the 4th edition text:

- Functions without a result type are allowed and callable only as statements.
- An omitted input of a formal call takes its declared initial value; this ADR
  applies that rule to user functions only, while standard functions require all inputs.
- An FB input can be assigned and read from outside the call (`inst.IN := x`,
  `y := inst.IN`).
- `VAR_IN_OUT` requires an actual variable of exactly the declared type on every
  call. Caller inputs, outputs and in-outs can be passed on; expressions,
  constants, bit access and `inst.X` members are rejected. Aliasing the same
  variable between parameters is allowed.
- Direct and indirect recursion are forbidden.
- Non-formal calls list every parameter in declaration order, including
  `VAR_IN_OUT` and `VAR_OUTPUT`, except EN/ENO. Supporting only input-only
  functions in this milestone is Partial support of that rule.

The following are benchtop-plc restrictions, not claims that the standard forbids
other behavior:

- Non-formal calls are allowed only for functions whose parameters are all `VAR_INPUT`.
- Functions cannot declare `VAR_TEMP` or FB instances.
- The `PROGRAM` cannot declare `VAR_INPUT`, `VAR_OUTPUT` or `VAR_IN_OUT` in this milestone.
- Direct addresses are allowed only in the `PROGRAM`.
- `CONSTANT` is allowed only on `VAR` sections.
- Overloaded timers and counters select their variant from `PT`/`PV` bindings
  within the declaring POU, with the inference exclusions and defaults above.

Issue #92 records each item. If a decision changes, the corresponding item there
must change with it. This ADR does not update `docs/compliance.md`: each
implementing sub-issue records its matching items there as Partial support or as
a restriction when the feature is implemented.

### Deferred scope

This ADR does not introduce `EN`/`ENO`, non-formal FB calls, FB instances as
parameters, `VAR_GLOBAL`/`VAR_EXTERNAL` or `RETAIN`. Multiple programs and tasks
belong to Milestone 6, reconsidering IEC 61131-10 belongs to Milestone 7, and
selecting an instance for inline debugging belongs to Milestone 8.

## Consequences

- Project-wide compilation resolves POU names and rejects recursion before
  execution. The compiler needs a POU-wide variant-selection pass before ordinary
  checking, but no iterative inference or dependence on source order.
- Function and FB code can remain shared plain IR data while persistent instance
  memory is separate. Load and cold reset must traverse the whole instance tree,
  including standard blocks' private state.
- Parseable projects with semantic errors can still be exchanged without losing
  their POU texts. The codec must use the same per-POU initializer check on save
  and open; unparseable drafts still depend on autosave.
- Dotted instance paths and POU-aware diagnostics give the UI enough information
  to monitor nested state and show faults in the correct source. Function locals,
  temporary variables and in-out aliases do not create extra monitoring identities.
- Keeping standard FB snapshots and the existing force stages limits changes to
  their consumers. Inline values remain limited to the program until debugging
  can select an instance explicitly.
- Implementation and conformance tests belong to the remaining sub-issues of
  #93. Accepting this ADR records the design; it does not make these features
  available in the app.

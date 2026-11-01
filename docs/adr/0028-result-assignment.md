# 0028. Require a result assignment in each evaluation

- Status: Accepted
- Date: 2026-11-01
- Partially supersedes: [0014](0014-user-defined-pous.md), Functions;
  [0017](0017-classes-methods-interfaces-and-namespaces.md), Methods
- Source: [issue #257](https://github.com/yasukei/benchtop-plc/issues/257)

## Context

ADR 0014 and ADR 0017 allow an unassigned result to return its type's default.
IEC 61131-3 Ed. 3, 7.3.3.2.3 instead requires an assignment to the POU name
when a result is defined. The most recent assignment is the returned value.
Without EN/ENO support, every completed evaluation with no assignment is an error.

## Decision

- An assignment statement to the function or method name counts. Assignments to
  any member, element or bit of the result also count. FOR control-variable
  initialization and increments count when the result is the control variable;
  even a zero-trip FOR initializes it. Complete aggregate
  initialization is not required. Other parts retain their initialized defaults.
- A `=>` binding targeting the result counts when its output copy executes.
  A `VAR_IN_OUT` actual targeting the result counts only if the callee actually
  writes the shared cell, including through nested aliases. Merely passing the
  result does not count. This also applies to aggregate members and elements.
- Assigning a reference result counts; writing through a dereferenced result
  changes its target, so does not count as assigning the reference result.
- The compiler rejects a function or concrete method with a result whose body
  contains no possible result assignment, using `pou.result-not-assigned`.
  Writable output targets and in-out actuals count as possible assignments.
  This check deliberately does not analyze reachability or all control-flow paths.
  Interface method prototypes and ABSTRACT methods have no body to check and
  are exempt. Declaration-only checks for project serialization remain unchanged.
- Each invocation starts with a fresh unassigned flag. Actual result writes set
  it, including writes through aggregate views and aliases. Reading the result
  or initializing its storage to defaults does not set it.
- At RETURN or normal body completion, an unset flag raises
  `runtime.result-not-assigned` before copying the invocation's outputs back.
  ADR 0010 fault handling preserves POU, instance, task and local statement span.
  A paused invocation keeps its flag when resumed. Abandoned debugger invocations
  do not validate results and do not raise this fault (ADR 0018).

## Consequences

Previously accepted programs may fail compilation or fault. Programs that intend
an early default return must explicitly assign it. The runtime checks actual
execution paths without rejecting conditional result assignments at compile time.
There is no IR format or project format change. A single write flag is shared by
all cells of an aggregate result and its in-out aliases for one invocation only.

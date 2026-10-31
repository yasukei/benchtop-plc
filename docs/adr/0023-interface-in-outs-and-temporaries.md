# 0023. Interface in-outs and temporaries

- Status: Accepted
- Date: 2026-10-31
- Extends: [0014](0014-user-defined-pous.md),
  [0016](0016-configurations-tasks-and-global-variables.md),
  [0017](0017-classes-methods-interfaces-and-namespaces.md)
- Source: [issue #236](https://github.com/yasukei/benchtop-plc/issues/236)

## Context

ADR 0017 permits interface variables in `VAR_IN_OUT` and `VAR_TEMP` of any
POU or method. It does not explicitly extend ADR 0016's ban on PROGRAM in-outs,
ADR 0014's ban on FUNCTION temporaries, or its own ban on method temporaries.
The implementation already makes interface-only exceptions to these bans.
PROGRAM interface in-outs also need a connection rule: copying an interface
value at task boundaries would lose writes that retarget the caller's cell.

## Decision

### PROGRAM interface in-outs

Allow `VAR_IN_OUT` in a PROGRAM only when every declaration in its in-out
sections is an interface variable or an array of interface variables. Ordinary
data in-outs remain compile errors (`pou.invalid-section`). This extends the
PROGRAM section rules of ADRs 0014 and 0016 and makes ADR 0017's exception explicit.

Each configured PROGRAM instance must connect every in-out with `:=` to a
mutable configuration/resource global of exactly the declared type. An interface
that extends the declared interface is not an exact match; arrays must also
have matching bounds and element types. Constants, `NULL`, concrete instances
and direct addresses cannot supply this binding. A missing binding reports
`call.missing-in-out`, including for the implicit configuration, which has no
globals or connection list.

The connection aliases the global interface cell, or the cells of an interface
array. It does not copy an interface value before or after PROGRAM execution.
Retargeting through either name is immediately visible through the other;
several in-outs may alias the same global. The IR storage mapping uses the
global storage directly, without an input/output transfer. Ordinary PROGRAM
input/output connections retain ADR 0016's copy semantics.

### Interface-only FUNCTION and method temporaries

Allow `VAR_TEMP` in a FUNCTION or method only when every declaration in its
temporary sections is an interface variable or an array of interface variables,
including nested arrays. A structure containing interface fields does not
qualify. Other temporary types, including a mixture of interface and ordinary
data declarations, remain compile errors (`pou.invalid-section`). This extends
ADR 0014's FUNCTION rule and ADR 0017's method rule.

These temporaries start from their declared/default `NULL` values on every call,
as other function/method locals do. They do not extend an instance's lifetime:
ADR 0017's persistent-target requirement still applies. PROGRAM and
FUNCTION_BLOCK temporary rules and CLASS section restrictions are unchanged.

### Verification

- [Compiler interface tests](../../packages/compiler/src/interfaces.test.ts):
  `binds a PROGRAM interface in-out to an exact-type global interface cell`,
  `binds PROGRAM arrays of interfaces with exact array types`,
  `rejects invalid PROGRAM interface in-out bindings: %s`, and
  `requires an explicit configuration to bind PROGRAM interface in-outs`
  cover binding, type/direction checks and missing bindings.
- [Interface conformance tests](../../tests/conformance/interfaces.test.ts):
  `aliases configured PROGRAM interface in-outs so retargeting is immediately shared`
  proves aliasing during execution;
  `resets interface-only FUNCTION and method temporaries on every call`
  covers scalar and nested-array temporaries;
  `restricts %s to interface-only declarations` covers the section restrictions,
  including mixed declarations and structures.

## Consequences

- The earlier bans retain their force for ordinary data; the interface exceptions
  are explicit without editing accepted ADRs 0014–0017.
- PROGRAM interface in-outs require an explicit configuration and exact global
  storage, even though ordinary interface assignment accepts compatible targets.
- This records existing behavior and project restrictions, not a new language
  feature or a verified claim about IEC 61131-3's 4th edition.

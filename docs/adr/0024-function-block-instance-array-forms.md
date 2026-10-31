# 0024. Function block instance array forms

- Status: Accepted
- Date: 2026-10-31
- Extends: [0015](0015-derived-types-strings-and-references.md)
- Source: [issue #236](https://github.com/yasukei/benchtop-plc/issues/236)

## Context

ADR 0015 allows named arrays, nested arrays and function block element types.
Read together, those rules appear to permit named and nested arrays of function
block instances. The compiler already rejects both forms, and the compliance
reference lists the restrictions, but no ADR records why.

Function block instances have persistent identity and an instance tree; they are
not ordinary aggregate values. The compiler handles instance arrays directly on
declarations, allocating each element's storage and selecting one overloaded
timer/counter variant per declaration. Named value types and nested value-array
operations do not provide that instance allocation and call model.

## Decision

Extend ADR 0015 with two implementation restrictions for both standard and user
function blocks:

- An instance array must be declared inline, for example
  `t : ARRAY[1..2] OF TON;`. A named instance-array type such as
  `TYPE Timers : ARRAY[1..2] OF TON; END_TYPE` is rejected with
  `decl.fb-array-form` and `{ form: "named" }`. Aliases do not bypass this rule.
- The array element must be a function block type directly. Nested arrays such
  as `t : ARRAY[1..2] OF ARRAY[1..2] OF TON;` are rejected with
  `decl.fb-array-form` and `{ form: "nested" }`. Deeper nesting is rejected too.
  Inline multidimensional instance arrays such as
  `t : ARRAY[1..2, 1..2] OF TON;` remain supported, within ADR 0015's bounds.

Report the restriction once per offending declaration, without treating a known
function block type as unknown or repeating it when aliases revisit a rejected
type. Named and nested arrays of ordinary values remain supported. Instance
placement, initialization, recursion, calls and member access keep their existing
rules under ADRs 0014–0017; this decision does not make instances copyable values.

### Verification

[Compiler function block array tests](../../packages/compiler/src/function-block-arrays.test.ts)
cover both standard `TON` and user `MotorStarter` elements:

- `explains named %s instance-array types without reporting known blocks as unknown`;
- `explains nested %s instance arrays once per declaration`;
- `reports one restriction for deeply nested instance arrays`;
- `does not repeat an unsupported array type diagnostic when aliases revisit it`.

The same file's `selects one timer/counter variant across all elements and member assignments`
accepts inline multidimensional arrays. The
[function block array conformance tests](../../tests/conformance/function-block-arrays.test.ts)
trace independent element state, indexed calls and cold reset.

## Consequences

- Users write instance arrays directly at each declaration and use a
  multidimensional array instead of a nested array when needed.
- The type/value machinery does not need to represent named instance templates
  or copy nested instance state. Supporting either rejected form would require
  a separate decision about allocation, identity and calls.
- This records existing implementation restrictions without changing accepted
  ST or claiming that IEC 61131-3 forbids these forms.

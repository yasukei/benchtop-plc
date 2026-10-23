# 0015. Derived data types, strings and references

- Status: Accepted
- Date: 2026-10-23
- Related: [0002](0002-tree-shaped-ir-as-plain-data.md),
  [0006](0006-plcopen-xml-project-format.md),
  [0010](0010-operating-states-restarts-and-runtime-errors.md),
  [0012](0012-elementary-data-types.md),
  [0013](0013-conversions-literals-and-operators.md),
  [0014](0014-user-defined-pous.md)
- Source: [issue #119](https://github.com/yasukei/benchtop-plc/issues/119)

## Context

Milestone 5 adds data type declarations, enumerated and subrange types, arrays,
structures, strings and references. Today every value is an elementary scalar:
`DataType` lists only elementary types, the runtime stores one cell per scalar, a
snapshot, write or force carries one `TypedValue` per `VariableId`, a JavaScript
`string` value already means a 64-bit decimal (ADR 0012), and the project codec
requires an empty `<dataTypes>`. The new types change the core types, the IR, runtime
memory, the UI–runtime protocol, the project file and the monitor together. The
implementation issues under [#118](https://github.com/yasukei/benchtop-plc/issues/118)
need one model.

As in ADR 0012 and ADR 0014, the 4th edition text (IEC 61131-3:2025) was not available
when this ADR was written. Decisions that depend on the standard follow the 3rd edition
text and secondary sources; they are not verified claims about 4th edition clauses. The
checks and project restrictions below are tracked in
[#92](https://github.com/yasukei/benchtop-plc/issues/92).

## Decision

### Type model

- `packages/core` gets a type descriptor, as plain data (ADR 0002):
  - an elementary type, as today's `DataType`;
  - `STRING` or `WSTRING` with a maximum length, `CHAR` or `WCHAR`;
  - an array: a list of dimensions, each with constant lower and upper bounds or `*`,
    and an element type;
  - a reference to a type;
  - a named type, referring to an entry of the type table.
- The IR has a type table with one entry per declared data type: an enumeration (value
  names and their integer values), a subrange (base type and limits), a structure
  (members in order, with their types and initial values) or an alias (another type and
  an initial value). Entries refer to each other by name; the table is a plain object
  or array, never a `Map`.
- Expressions, variables and diagnostic arguments carry the descriptor where they now
  carry a `DataType`. A diagnostic names a type by its source text, for example
  `ARRAY[1..10] OF INT`, `STRING[20]`, `Color` or `REF_TO Point`; for elementary types
  this is the existing name, so existing messages do not change.
- `DataType` and `TypedValue` keep describing one scalar leaf. `STRING`, `WSTRING`,
  `CHAR` and `WCHAR` join them; a string leaf is one value, not an array of characters.
  The declared length of a `STRING[n]` is part of the variable's descriptor, not of the
  `TypedValue`.
- Type compatibility:
  - Enumerations and structures use name equivalence: two structure types with the same
    members are different types.
  - Arrays use structural equivalence: two array types are the same type when their
    bounds and element types are the same. A named array type is the same as its
    definition.
  - An alias (`TYPE Speed : INT := 100; END_TYPE`) is the same type as its base; only
    its default value differs.
  - A subrange value is used as a value of its base type. A value of the base type can
    be stored into a subrange variable, checked as described under Subranges.
  - A string's length is a capacity, not part of its type: `STRING[n]` and `STRING[m]`
    are the same type everywhere, including array elements, in-out parameters and
    reference targets. Whenever a value is stored into a string variable, element or
    member, that storage's own length applies (see Strings). So an
    `ARRAY[1..3] OF STRING[10]` can be assigned to an `ARRAY[1..3] OF STRING[20]` and
    the other way round, element by element.

### Value encoding

- In the IR and the protocol every value travels with its type (`TypedValue`, typed IR
  constants), so a JavaScript `string` is unambiguous there: a canonical decimal for a
  64-bit type (ADR 0012), characters for `STRING`, `WSTRING`, `CHAR` and `WCHAR`.
- Inside the runtime, values without a type beside them use `bigint` for 64-bit types
  and `string` only for characters, converting at the runtime boundary. Today the
  interpreter and the standard functions treat any JavaScript `string` met during
  evaluation as a 64-bit value; those places change to `bigint`, and the implementation
  audits every `typeof value === "string"` check in the runtime, core and web.
- A string is stored as a sequence of UTF-16 code units. In `STRING` and `CHAR` every
  code unit is 0–255, read as ISO/IEC 8859-1. A `CHAR` or `WCHAR` value is a string of
  exactly one code unit.

### Data type declarations

- Each data type is its own project source: `TYPE Name : <type>; END_TYPE`, optionally
  with `:= <initial value>` before the semicolon, holding exactly one type. Data type
  sources are kept in their own ordered list, before the POUs in the POU list, and each
  one is saved as one TC6 `dataType`. A separate list matches TC6, which keeps
  `dataTypes` apart from `pous`, so the order survives saving and opening; it also keeps
  the per-POU editing model of ADR 0014.
- Type names share the ADR 0014 namespace with POU names and standard names. A
  duplicate, a clash with a POU or standard name, and an unknown type name are compile
  errors. Diagnostics in a data type source name that source as they name a POU.
- A structure or array type that contains itself, directly or through other arrays and
  structures, is a compile error. A reference does not contain its target, so
  `REF_TO Node` inside `Node` is allowed.
- Types are declared only in data type sources, not inside POUs (restriction; the 3rd
  edition has no local type declarations either).

### Enumerations

- `TYPE Color : (Red, Green, Blue); END_TYPE` numbers the values from 0 in order.
  `TYPE Mode : INT (Off := 0, Auto := 10, Manual := 20); END_TYPE` gives explicit
  values over an integer base type; without a base type, explicit values are INT.
  Values must be distinct and fit the base type. The default is the first value, unless
  the declaration gives `:= <value>`.
- `Color#Red` is always allowed. An unqualified `Red` is allowed where an enumerated
  type is expected: an assignment or initializer target, the other operand of `=` or
  `<>`, a `CASE` label of an enumerated selector, or a parameter. If no enumerated type
  is expected there, or a variable in scope has the same name, the unqualified name is
  a compile error and must be qualified. Value names do not enter the ADR 0014 namespace.
- Allowed operations: assignment, `=`, `<>`, `CASE` labels, `SEL`, `MUX` and `MOVE`.
  Arithmetic, ordering, implicit conversion and conversion functions are compile
  errors.
- The monitor shows the value name with its declared spelling (`Running`) and accepts
  it in any case.

### Subranges

- `TYPE Percent : INT (0..100); END_TYPE` and the anonymous form `p : INT (0..100);`
  over any integer base type. The limits are constant expressions with
  `lower <= upper`.
- The default is the lower limit, unless the declaration gives `:= <value>`, following
  the 3rd edition. So `TYPE Offset : INT (-10..10); END_TYPE` starts at -10, not 0.
- A constant outside the range is a compile error (`type.invalid-constant`).
- Every store into a subrange variable at run time is checked: assignment, `=>`, an
  input or output parameter, and a function result. A value outside the range faults
  with `runtime.subrange-violation` (`{ value, lower, upper }`). Arithmetic on subrange
  operands uses the base type; only the store is checked.
- A subrange variable cannot be the control variable of a `FOR` loop (restriction): the
  loop leaves its variable one step past the end value (see `docs/runtime.md`), which
  would fault on every normal exit. Loop over a base-type variable instead.
- A monitor write or force outside the range is rejected without changing the value.

### Arrays

- `ARRAY[l..u, ...] OF T`, anonymous in a declaration or named in a data type source.
  Bounds are constant integer expressions with `l <= u`. In a POU they may use the
  POU's `CONSTANT` variables; in a data type source no constants are in scope, so only
  literals and their arithmetic. At most 3 dimensions, which keeps paths and the
  monitor tree readable; an element type may itself be an array type, accessed as
  `m[i][j]`.
- Element types: elementary types, strings, enumerations, subranges, structures,
  references, other arrays, and standard or user function block instances.
- Limits (restrictions): an array has at most 10,000 elements, and one variable has at
  most 10,000 scalar leaves in total, counting nested arrays and structures and the
  monitored members of function block elements.
- `a[i, j]` takes integer expressions of any integer type. An index outside the bounds
  faults with `runtime.index-out-of-range` (`{ index, lower, upper }` for the offending
  dimension). A constant index outside the bounds is a compile error.
- Initializers list elements in order, row-major, with repetition: `[1, 2, 3(0)]`
  and `[2(1, 2)]`. Missing trailing elements take the element type's default; more
  values than elements is a compile error.
- Whole-array assignment between variables of the same array type copies every element.
  Comparing whole arrays is a compile error.
- Arrays of values may be declared in every section that ADR 0014 allows for the POU
  kind. Lifetime and initialization follow ADR 0014: function locals and `VAR_TEMP`
  start from their initial values on every call or scan.
- Bit access applies to elements: `flags[i].3`.

### Structures

- `TYPE Point : STRUCT x : REAL; y : REAL := 1.0; END_STRUCT; END_TYPE`. Member types
  are those allowed as array elements, except function block instances (restriction).
  A member's initializer is its default.
- Members are accessed with `.` in chains of any depth: `line[2].start.x`,
  `recipe.steps[i].time`. `name.<digits>` and `name.<constant>` on a bit-string value
  stay bit access; on a structure `.` always names a member, and member names are
  identifiers, so the two cannot be confused.
- Initializers name members: `(x := 1.0, y := 2.0)`, nested inside array and structure
  initializers. Missing members take their defaults; an unknown or repeated member is a
  compile error.
- Whole-structure assignment between variables of the same structure type copies every
  member. Comparing whole structures is a compile error.
- `OVERLAP`, relative addresses (`AT %X*`) and partial structure access are not
  provided.

### Aggregate initializers and constants

- Array and structure initializers appear only in declarations, in data type sources
  and as variable initializers. They are not expressions in a body (restriction).
- `CONSTANT` is allowed for strings, enumerations, subranges and aliases of elementary
  types. Constant arrays and structures are compile errors in this milestone
  (restriction); a `VAR` with an initializer serves as a table.

### Strings and characters

- `STRING` and `CHAR` hold single-byte characters, `WSTRING` and `WCHAR` UTF-16 code
  units.
- `STRING` and `WSTRING` without a length can hold 80 characters, as in CODESYS and
  PLCnext. A declared length is 1 to 1,024 (restriction), which bounds snapshot and
  monitor sizes. `STRING[n]` is the 3rd edition form; `STRING(n)` is not accepted
  (restriction).
- Defaults: `''`, `""`, `CHAR#'$00'` and `WCHAR#"$0000"`.
- Literals:
  - `'...'` is single-byte, with `$$`, `$'`, `$L`, `$N`, `$P`, `$R`, `$T` (either
    case) and `$hh`; `"` stands for itself.
  - `"..."` is double-byte, with the same escapes except `$"` instead of `$'` and
    `$hhhh` instead of `$hh`; `'` stands for itself.
  - Any other `$` sequence, an unterminated literal, a character above 16#FF in a
    single-byte literal, and a line break inside a literal are compile errors.
  - Typed literals `STRING#'...'`, `WSTRING#"..."`, `CHAR#'a'` and `WCHAR#"a"`.
- Contextual typing extends ADR 0013 rule 2: an untyped `'...'` literal takes the
  destination type `STRING` or `CHAR`, and `"..."` takes `WSTRING` or `WCHAR`; elsewhere
  they are `STRING` and `WSTRING`. A literal for `CHAR` or `WCHAR` must have exactly one
  character, and a literal longer than its destination's length is a compile error
  (`type.invalid-constant`), as an integer constant out of range is under ADR 0013. So
  `msg : STRING[5] := 'Hello world';` does not compile.
- Implicit conversions: `CHAR` → `STRING` and `WCHAR` → `WSTRING`. Every other
  conversion between character types needs a function.
- Storing a run-time value longer than the target's length keeps its first characters
  and drops the rest, without a fault. This applies to every store: assignment, `=>`,
  parameters, in-outs and references (the length of the actual storage applies), and
  whole-array or structure copies. With `msg : STRING[5]` and `s := 'Hello world'` in a
  `STRING`, `msg := s;` gives `'Hello'`.
- `=`, `<>`, `<`, `>`, `<=`, `>=`, `MAX`, `MIN`, `LIMIT`, `SEL`, `MUX` and `MOVE` work
  on `STRING` with `STRING` and `WSTRING` with `WSTRING`, `CHAR` and `WCHAR` included
  through their implicit conversions. Ordering compares code units from the left; a
  prefix sorts first.

### String functions

- Positions are 1-based and lengths count characters (code units for `WSTRING`). `L`
  and `P` take any integer type. `LEN` and `FIND` return INT.
- `LEN(IN)`, `LEFT(IN, L)`, `RIGHT(IN, L)`, `MID(IN, L, P)`, `CONCAT(IN1, IN2, ...)`
  (extensible, at least two inputs), `INSERT(IN1, IN2, P)`, `DELETE(IN, L, P)`,
  `REPLACE(IN1, IN2, L, P)` and `FIND(IN1, IN2)`, for `STRING` and `WSTRING`.
  `INSERT` puts `IN2` after the `P`-th character of `IN1`; `DELETE` removes `L`
  characters starting at position `P`; `REPLACE` replaces `L` characters starting at
  `P` with `IN2`.
- A result has the type of `IN` or `IN1` and can hold up to 1,024 characters, the
  largest declarable length; a longer result keeps its first 1,024 characters. Storing
  it then applies the target's length, so `CONCAT` of two 60-character values into a
  `STRING[200]` keeps all 120 characters.
- Errors (`runtime.invalid-value`, as for a `MUX` selector out of range):
  - `L < 0`, or `P < 1` for `MID`, `DELETE` and `REPLACE`;
  - `P > LEN(IN)` for `MID`, `DELETE` and `REPLACE`, so every `P` faults on an empty
    string; and `P < 0` or `P > LEN(IN1)` for `INSERT` (`P = 0` inserts at the front).
- A length that reaches past the end of the string is clamped: `LEFT('ABC', 5)` is
  `'ABC'`, `MID('ABC', 5, 2)` is `'BC'`, `DELETE('ABC', 5, 2)` is `'A'`.
- `FIND` returns the position of the first occurrence, or 0 if there is none; finding
  `''` returns 0.
- Conversions:
  - `<type>_TO_STRING` and `<type>_TO_WSTRING` for every elementary type except the
    character types, and the overloaded `TO_STRING`/`TO_WSTRING`, write the value as
    the monitor shows it (`formatValue`, ADR 0012): `INT_TO_STRING(-42)` is `'-42'`,
    `BOOL_TO_STRING(TRUE)` is `'TRUE'`, `TIME_TO_STRING(T#1500ms)` is `'T#1s500ms'`.
  - `STRING_TO_<type>` and `WSTRING_TO_<type>` accept what a typed literal of the type
    accepts after its `<type>#` prefix, with or without the prefix, and surrounding
    spaces. Anything else, or a value outside the type, faults with
    `runtime.invalid-value`.
  - `STRING_TO_WSTRING`, `WSTRING_TO_STRING`, `CHAR_TO_STRING`, `WCHAR_TO_WSTRING`,
    `STRING_TO_CHAR`, `WSTRING_TO_WCHAR` (the first character; `''` faults),
    `CHAR_TO_WCHAR`, `WCHAR_TO_CHAR`, `CHAR_TO_BYTE`, `BYTE_TO_CHAR`, `WCHAR_TO_WORD`
    and `WORD_TO_WCHAR`. A character above 16#FF converted to single-byte faults with
    `runtime.invalid-value`.
- `CONCAT_DATE`, `CONCAT_TOD` and the other existing families keep their names.

### References

- `REF_TO T` for any type allowed as an array element except function block instances
  (restriction). `REF(x)` gives a reference to a variable, element or member; `r^`
  dereferences it and chains as `r^.x` and `r^[i]`. `NULL` is the default and can be
  assigned and compared.
- Reference types match exactly: `REF(x)` with `x : INT` is a `REF_TO INT`, and only a
  `REF_TO INT` or `NULL` can be stored in a `REF_TO INT`. `=` and `<>` compare two
  references of the same type, or a reference with `NULL`.
- `REF()` accepts only variables that live as long as the program instance, and their
  elements and members:
  - `VAR` variables of the `PROGRAM`;
  - inside a function block, its own `VAR_INPUT`, `VAR_OUTPUT` and `VAR` (they live as
    long as the instance);
  - from outside an instance, the members ADR 0014 lets the caller access
    (`REF(m1.Speed)` for an input or output).
- `REF()` of `VAR_TEMP`, of any variable or parameter of a function, of a `VAR_IN_OUT`
  parameter of any POU (its actual may be temporary), of a constant or of an expression
  is a compile error. A reference's initializer can only be `NULL` (restriction), so
  load and cold reset set every reference to `NULL`. A reference therefore never
  outlives its target.
- `r^` with `r = NULL` faults with `runtime.null-reference`.
- References may be variables, array elements, structure members, parameters and
  function results.

### Parameters and results

- Arrays, structures, strings, enumerations, subranges and references can be
  `VAR_INPUT` (copied in), `VAR_OUTPUT` (copied out by `=>`), `VAR_IN_OUT` (an alias,
  as in ADR 0014) and function results.
- An in-out actual parameter must have exactly the declared type, string lengths
  aside: for arrays, the same bounds and element type. Stores through the in-out use
  the actual's length. Elements and members can be passed to in-outs
  (`F(io := a[2])`, `F(io := p.x)`); the index is evaluated once, before the call.
  ADR 0014's ban on bit access and `inst.X` members for in-outs stays.
- `ARRAY[*]` (with as many `*` as dimensions) is allowed only for `VAR_IN_OUT`, as in
  the 3rd edition; any array of the same element type and number of dimensions can be
  passed. `LOWER_BOUND(a, d)` and `UPPER_BOUND(a, d)` return the bounds of dimension
  `d` of any array as DINT; `d` is a constant from 1 to the number of dimensions.
- A function result of a composite type is assigned whole:
  `p := MakePoint(x := 1.0, y := 2.0);`.

### Arrays of function block instances

- `ARRAY[l..u, ...] OF <function block>` for standard and user function blocks, in the
  `VAR` sections where ADR 0014 allows instances. Each element is an instance with its
  own memory, and load and cold reset initialize every element's instance tree.
- Calls `t[i](IN := x, PT := p, Q => done)` and member access `t[i].Q` follow ADR 0014's
  call and access rules; the index is checked before the call.
- An overloaded `TON`, `CTU` and the like in an array select one variant for the whole
  array declaration, from the bindings to any element's `PT` or `PV`, with the rules
  of ADR 0014.

### Run-time errors

This ADR adds these rows to the table of ADR 0010:

| Condition                                                             | Reaction                           |
| --------------------------------------------------------------------- | ---------------------------------- |
| Array index outside the bounds, including `ARRAY[*]`                  | FAULT `runtime.index-out-of-range` |
| Value stored into a subrange variable outside its range               | FAULT `runtime.subrange-violation` |
| Dereference of `NULL`                                                 | FAULT `runtime.null-reference`     |
| Invalid position or length in a string function                       | FAULT `runtime.invalid-value`      |
| String that does not convert, or character above 16#FF to single-byte | FAULT `runtime.invalid-value`      |
| String longer than the target                                         | Truncated, no fault                |

A fault names the POU and instance path, as in ADR 0014.

### Monitoring

- Composite variables are flattened: every scalar leaf (a scalar element or member, a
  string, an enumeration, a reference) gets its own `VariableId`, and a composite
  variable's leaves have consecutive IDs. Each leaf has a display path (`A[3]`,
  `M[2,1]`, `P.X`, `LINE[2].START.X`, `M1.RECIPE.NAME`) and the same path as a list
  of segments, so the UI can build the tree. A standard FB element keeps its ADR 0014
  representation under its path (`T[2]`); a user FB element's members follow ADR 0014
  under `M[2].RUNNING`.
- Writes and forces address one leaf by `VariableId`, as today. A whole array or
  structure cannot be written or forced.
- The monitor shows a composite variable as one collapsible row with its leaves
  below it. Strings show as quoted literals with `$` escapes, enumerations by value
  name, references by their target path or `NULL`. References cannot be written or
  forced.
- Leaves inside an array are reported in snapshots only while the UI watches them (for
  example while their row is expanded). The UI sends the set of watched leaves; every
  other leaf is reported on every snapshot as today. A forced leaf is always reported,
  watched or not, so forced values inside a collapsed array stay visible in the list of
  forces.
- Inline values in the `PROGRAM` show scalar results: strings quoted, enumerations by
  name, references by target path. An assignment of a whole array or structure shows
  nothing.

### Project file

- TC6 v2.01 mapping:
  - a data type source is one `types/dataTypes/dataType` with its `baseType` and, if
    given, `initialValue`, and keeps its exact text in the benchtop-plc source
    extension, as POUs do (ADR 0014);
  - `STRING[n]` and `WSTRING[n]` are `string` and `wstring` with `length`;
  - arrays are `array` with one `dimension` (`lower`, `upper`) per dimension and a
    `baseType`; enumerations `enum` with `values/value` (`name`, `value`); subranges
    `subrangeSigned` or `subrangeUnsigned`; structures `struct`; references `pointer`;
    named types `derived`;
  - array and structure initial values are `arrayValue` (with `repetitionValue`) and
    `structValue`.
- Array bounds are written as folded numbers, even when the source uses a constant
  (`ARRAY[1..N]`); the source extension keeps the text.
- TC6 v2.01 has no `CHAR` or `WCHAR`; they are written as `derived` with those names,
  which the reader recognizes. This is a benchtop-plc convention that other tools may
  not understand. `ARRAY[*]` is written as `array` with `dimension lower="*" upper="*"`,
  which the schema accepts because it types bounds as strings.
- Saving and opening check initializers as in ADR 0014, with the project's data types
  in scope: a data type source must parse, an unknown type name does not block, and a
  constant that does not fit its type blocks.
- Files written by 0.4.0 open unchanged.

### Generic types

- The generic families gain `ANY_CHAR` (`CHAR`, `WCHAR`), `ANY_STRING` (`STRING`,
  `WSTRING`) and `ANY_CHARS` (both), all part of `ANY_ELEMENTARY`, as in the 3rd
  edition. `ANY_DERIVED` covers enumerations, arrays, structures and references; a
  subrange or an alias counts as its base type.
- `MOVE`, `SEL` and `MUX` accept any type, arrays and structures included, when all
  their value operands have exactly the same type (string lengths aside).
- Comparisons, `MAX`, `MIN` and `LIMIT` accept elementary types, strings and characters
  included, as described under Strings. Enumerations allow only `=` and `<>`.
- Wherever a standard function takes `ANY_INT` or another elementary family, a subrange
  argument counts as its base type.

### Names

- New keywords: `REF_TO`, `REF`, `NULL`, `CHAR` and `WCHAR`. `ARRAY`, `OF`, `STRUCT`,
  `END_STRUCT`, `TYPE`, `END_TYPE`, `STRING` and `WSTRING` are already reserved.
- New standard names joining the ADR 0014 namespace: the string functions and
  conversions above, `LOWER_BOUND` and `UPPER_BOUND`. A program that uses one of these
  words or names as an identifier stops compiling; the changelog lists this (ADR 0011).

### Restrictions and points to check

The following decisions are based on the 3rd edition and need verification against the
4th edition text:

- Enumeration values number from 0; typed enumerations give explicit integer values;
  unqualified value names are resolved from the expected type.
- The default of a subrange is its lower limit; storing a value outside the range is
  an error.
- Array initializers fill missing trailing elements with defaults; arrays are
  compatible structurally, structures and enumerations by name.
- `STRING[n]` declares the length; literal escapes are
  `$$ $' $" $L $N $P $R $T $hh $hhhh`; defaults are `''`, `""`, `CHAR#'$00'` and
  `WCHAR#"$0000"`.
- Single-byte strings use ISO/IEC 8859-1 codes; whether the 4th edition adds further
  string types (for example UTF-8) is not checked, and none is provided.
- String functions use 1-based positions; `LEN` and `FIND` return INT.
- `CHAR` → `STRING` and `WCHAR` → `WSTRING` are the only implicit conversions between
  character types.
- `REF()` is not allowed on temporary variables, function variables or parameters.
- `ARRAY[*]` is allowed only for `VAR_IN_OUT`, with `LOWER_BOUND` and `UPPER_BOUND`
  returning DINT.
- The generic families `ANY_CHAR`, `ANY_STRING`, `ANY_CHARS` and `ANY_DERIVED`, and
  `MOVE`, `SEL` and `MUX` on any type.

The following are benchtop-plc restrictions or choices, not claims that the standard
forbids other behavior:

- Data types are declared only in data type sources, one type per source, listed
  before the POUs.
- An unqualified enumeration value that matches a variable in scope must be qualified.
- Enumerations allow no ordering and no conversion functions.
- A run-time store outside a subrange faults; a subrange variable cannot control a
  `FOR` loop.
- Arrays have at most 3 dimensions and 10,000 elements; a variable has at most 10,000
  scalar leaves.
- Aggregate initializers appear only in declarations; constant arrays and structures
  are not provided.
- The default string length is 80; declared lengths are at most 1,024; `STRING(n)` is
  not accepted.
- A string literal longer than its destination is a compile error; storing an
  over-long run-time string truncates it without a fault; a string's length is not
  part of its type.
- Invalid positions and lengths in string functions fault; lengths past the end are
  clamped.
- String conversions use the monitor's value format and literal syntax.
- `REF()` is also not allowed on in-out parameters or expressions; a reference's
  initializer can only be `NULL`.
- Function block instances cannot be structure members or reference targets.
- `OVERLAP` and relative addresses in structures are not provided.
- `CHAR` and `WCHAR` are stored in TC6 v2.01 as `derived` names, and `ARRAY[*]` with
  `*` bounds.

Issue #92 records each item. If a decision changes, the corresponding item there must
change with it. This ADR does not update `docs/compliance.md`: each implementing
sub-issue records its matching items there as Partial support or as a restriction when
the feature is implemented.

### Deferred scope

This ADR does not introduce classes, interfaces, `?=` or namespaces (Milestone 7),
dynamic memory, pointer arithmetic, or references to function block instances. TC6
v2.01 also lacks `LTIME`, `LDATE`, `LTOD` and `LDT`, which the codec writes today; that
gap is left for a follow-up issue.

## Consequences

- One type descriptor reaches every package. Most changes are mechanical where code
  only passes a `DataType` along, but the checker, the codec and the monitor need real
  work for composite types.
- Flattened leaves keep writes, forces and snapshots per `VariableId`, so the force
  stages of ADR 0010 and ADR 0014 apply unchanged to elements and members. Dynamic
  indexing becomes an offset into consecutive leaves, and whole assignment becomes a
  range copy. The cost is a larger variable table, bounded by the leaf limits.
- Reporting array leaves only while they are watched keeps snapshot size close to
  today's for programs with large arrays, at the cost of a new UI-to-runtime message.
- Restricting `REF()` to long-lived variables rules out dangling references without a
  run-time check; the price is that references cannot point into function locals.
- String faults follow the existing `MUX` and shift precedent, so a bad position stops
  the program with a span instead of producing a silent empty string.
- Reserving `REF`, `NULL`, `CHAR`, `WCHAR` and the new standard names can break
  existing programs that use them as identifiers.
- Implementation and conformance tests belong to the remaining sub-issues of #118.
  Accepting this ADR records the design; it does not make these features available in
  the app.

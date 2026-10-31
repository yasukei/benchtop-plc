# Compiling Structured Text

`@benchtop-plc/compiler` exports `compile(source): CompileResult` for existing
single-program callers and `compileProject(sources, dataTypeSources?, configurationSource?, implicit?): CompileResult`
for an ordered list of POU texts and a separate ordered list of data type texts.
Each source contains exactly one declaration. Data types are resolved before POUs. It runs the
[parser](compiler-parser.md), [semantic checker](type-checking.md) and IR lowering
in order. Success returns `{ ir: ConfigurationIR, diagnostics }`, with any portability warnings. Failure returns
`{ diagnostics: CompileDiagnostic[] }` with the `ir` property omitted; no partially valid
IR is exposed. Diagnostics retain the earlier stage's codes, arguments and spans,
and carry the source POU name in `pou` when its header is known. Every `compileProject` diagnostic
belonging to a POU also carries a zero-based `sourceIndex` into the input list,
including lexer errors and diagnostics for duplicated names. Project-level
program-count errors omit `pou`, `sourceIndex` and `span`. The single-source
`compile` entry point preserves its existing diagnostic shape without `sourceIndex`.

Without a configuration source a project requires exactly one `PROGRAM`; the diagnostic recommends a configuration source for several programs. `parsePou(source)` parses a `PROGRAM` or
`FUNCTION` or `FUNCTION_BLOCK`; `parse(source)` remains the single-program parser.
Project-wide compilation collects signatures before checking any bodies, so forward
calls work, and checks function calls and block containment for direct or indirect recursion.
See [ADR 0014](adr/0014-user-defined-pous.md). The web editor manages the ordered POU list and PLCopen XML preserves each text.

`lower(checkedPrograms, configuration, blocks?): ConfigurationIR` is also available for callers that already have a
successful checking results. It expects the AST and its semantic side tables
to remain intact. It produces a fresh plain-data tree without mutating or sharing
mutable objects with the AST. Maps, source identifier objects and unneeded parser
fields never appear in the IR.

## Syntax errors and project checking

When a POU body has a syntax error, compilation retains its header and declarations
if they have all parsed successfully, including any method definitions before the
body. These declarations still participate in project name, kind and signature
resolution, so semantic diagnostics in other, fully parsed POUs remain visible.
The failed POU's body and methods are not semantically checked. The compiler does
not resume parsing within the failed body or report further syntax errors there.
Project-wide resolution errors still stop subsequent checking as usual.

If a header or variable declaration is damaged, checking stops for the whole
project: its complete names, kinds and signatures are unknown. An error that
interrupts parsing a method also stops checking because later method signatures
may be unknown. Lexer
errors, malformed source wrappers and extra declarations in a source remain a
barrier to checking; the compiler does not guess missing declarations or search
past an error. Invalid data type sources retain their existing checking barriers.

Any syntax error prevents IR generation, even when every other POU checks
successfully. The public `parse` and `parsePou` entry points continue to return
`ast: null` on failure; declaration recovery is internal to project compilation.

## Data type sources

```ts
const result = compileProject(
  ["PROGRAM Main VAR phase : State; END_VAR phase := Running; END_PROGRAM"],
  ["TYPE State : (Idle, Running, Done); END_TYPE"],
);
```

The second list defaults to empty, preserving existing callers. Each source uses
`TYPE Name : ... ; END_TYPE`. Supported definitions are aliases of elementary or
other supported named types, enumerations, and integer subranges. Forward type
references resolve case-insensitively; cycles, duplicate names, unknown types and
clashes with POUs or standard names are errors. Type declarations cannot appear
inside a POU. `ConfigurationIR.types` preserves declaration order; inline subranges do
not add entries. POU signatures resolve bounds in their own constant scope before
call sites are checked.

A diagnostic from this list uses `pou` for the type source's name,
`sourceKind: "dataType"` and `sourceIndex` into the data type list. POU diagnostics
keep their existing identity and indexing. The project model and PLCopen XML retain
both lists, and the web app compiles imported data types with its POUs. The [web app](web-app.md)
lists and edits data types before the POUs.

`resolveDataTypes(declarations)` also exposes type resolution for parsed data type
ASTs, returning a type table and diagnostics without requiring a complete program.
The project codec uses it to fold enum values and subrange bounds and to check
initializers with project types in scope.
PLCopen XML preserves inline subranges through signed or unsigned TC6 subrange
elements; see [project-format.md](project-format.md#data-type-mapping).

## Representation

The IR follows [core-contracts.md](core-contracts.md). Declarations stay in source
order; names in a grouped declaration become separate variables with the same
declaration span. Scalar initializers/defaults come from the checker's coerced
values. Direct addresses and explicit located-initializer markers are copied when present. FB initial values are null.
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

`ConfigurationIR.functions` contains each function body once, in project function order.
A `userFunctionCall` references that table by index; its inputs retain source
evaluation order and use resolved local variable indices. Outputs likewise bind a
callee local index to a writable caller target. Each definition has its own local
variable table, input/output indices and optional result variable index. A result
variable is appended after declared locals and starts at the result type's default.
An expression call has a type descriptor in `dataType`; a no-result statement call has
`dataType: null`. Standard functions retain their opcode representation; formal
calls include `evaluationOrder` when signature order differs from source order.

## User function blocks and storage

`ConfigurationIR.functionBlocks` holds each block body once. `userFbCall.variable` selects
an instance slot in the caller's frame, and `userFbMember` selects a public scalar
input/output by its declaration slot in that instance. User and standard FB calls
support named `:=` inputs and `=>` output bindings, with assignment widening.

`ConfigurationIR.variables` is the flat monitored storage table: program scalars and
standard FBs, plus every persistent scalar or standard FB below a user instance.
Nested entries use canonical dotted names, such as `mainInstance.M1.RUNNING` and `mainInstance.M1.DELAY`.
`resource.programs[i].storage` maps each PROGRAM instance's declaration slots to those VariableIds, temporary scalar
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

## Arrays of function block instances

PROGRAM and FUNCTION_BLOCK `VAR` sections can declare inline instance arrays,
such as `t : ARRAY[1..4] OF TON;` or `m : ARRAY[1..2] OF MotorStarter;`.
Up to three dimensions use the same constant bounds and checked indexing as value
arrays. A function cannot declare instances, and instances cannot be constants,
temporaries, parameters or function results. Instance arrays have no initializer
and cannot be copied or passed to whole-array selection functions.

Call an element with formal arguments: `t[i](IN := run, PT := presets[i], Q => done)`.
Read its public inputs/outputs with `t[i].IN` and `t[i].Q`; only inputs are writable
from outside the block. User block private members and in-outs remain inaccessible.
Every element shares its block's code and has its own persistent instance tree.
Overloaded timer/counter selection combines eligible PT/PV bindings across all
elements of the declaration; use a typed block name to fix the variant explicitly.

## Configuration source

The optional third argument contains one configuration source. For example:

```ts
const result = compileProject(
  ["PROGRAM Counter VAR n : INT; END_VAR n := n + 1; END_PROGRAM"],
  [],
  `CONFIGURATION Plant
   RESOURCE Station ON BENCHTOP
     TASK T (INTERVAL := T#20ms, PRIORITY := 1);
     PROGRAM A WITH T : Counter;
     PROGRAM B WITH T : Counter;
   END_RESOURCE
   END_CONFIGURATION`,
);
```

One configuration, one resource, 1–16 cyclic or event tasks and 1–64 program
instances are supported. `ON` accepts an arbitrary identifier and has no execution
effect.
Every instance requires `WITH` and a known task; its type must name a `PROGRAM`.
The configuration, resource, task and instance names share a case-insensitive
namespace excluding POU, data type and standard names. Every POU is checked, even
when no instance references it; an uninstantiated PROGRAM has no storage and does
not execute.

Each task requires either `INTERVAL` (cyclic) or `SINGLE` (rising-edge event),
together with `PRIORITY`, in either order. The interval is a
TIME/LTIME literal from 10 ms to 1 h in whole multiples of 10 ms; exact literal
arithmetic prevents rounding fractional values into range. Priority is an integer
literal from 0 to 65535. `INTERVAL`, `SINGLE` and `PRIORITY` remain ordinary
identifiers outside task parameter positions. `SINGLE` accepts a BOOL input address
or a BOOL configuration/resource global, including one located in the input area.

Configuration diagnostics carry `sourceKind: "configuration"`, `sourceIndex: 0`,
and the configuration name in `pou` when its header is known. The source index is
separate from POU and data type indexes.

With no source the fourth argument supplies existing project metadata:
`{ name?, resource?, task?: { name?, intervalMs?, priority? }, instance? }`.
Defaults are `Config`, `Res`, `Cyclic` (10 ms, priority 1) and `mainInstance`.
The result always contains a configuration, with `explicit: false` for this
implicit form. Its instance variables already use paths such as
`mainInstance.LAMP`; adding an explicit source need not change their identity.

## Global variables and externals

An explicit configuration may declare `VAR_GLOBAL` and `VAR_GLOBAL CONSTANT`
before its resource and before the resource's task. Configuration globals are
checked and allocated before resource globals, in declaration order. A `PROGRAM`
or `FUNCTION_BLOCK` imports a global with `VAR_EXTERNAL` (and `CONSTANT` when
required); a `FUNCTION` cannot use externals. Implicit configurations have no globals.

Globals accept the same types as persistent PROGRAM variables, including derived
types, references, and standard/user FBs and FB arrays. Externals alias shared storage;
they allocate no duplicate monitor leaves. Global FB overload selection combines
bindings across every POU, including bodies without a configured instance. Global
constants are folded and omitted from storage, and imported constants can supply
array bounds and CASE labels. `lower` accepts an optional checked globals argument
following the block definitions.

## PROGRAM parameters and connections

PROGRAMs accept `VAR_INPUT` and `VAR_OUTPUT`, plus `VAR_IN_OUT` for interface
variables and arrays of interfaces. Every in-out requires an explicit configuration
connection (`:=`) to a mutable global of exactly the same type.
`AT` on a PROGRAM parameter declaration is rejected (`decl.parameter-address`);
connect direct addresses in the configuration instead.
An instance can connect named parameters, for example:

```iecst
PROGRAM A WITH T : Main (Start := %IX0.0, Lamp => %QX0.0, Threshold := gThreshold);
```

Connection lists must contain at least one connection and cannot end with a comma.
Omit the parentheses when every input/output is unconnected and there are no in-outs.

Input sources are constants (including constant expressions and enumeration values),
globals, or direct addresses. Output destinations are mutable globals or output/memory
addresses, with every size/type binding below. Globals use ordinary
input/assignment conversions; addresses bind the parameter type as an `AT` would.

`resource.programs[i].inputs` and `.outputs` describe transfers between the
parameter storage and a global storage slot, constant, or address. Connected input
leaves carry `connectedInput: true`. PROGRAM bodies and storage remain independent
of the connection lists, so every instance can connect to different sources.
Interface in-outs instead share the connected global storage directly, with no
input/output transfers; assignments through either name are immediately visible.

At task start the runtime reads inputs, consumes pending writes, and restores forces.
For each instance in declaration order it copies connected inputs, restores forces,
executes the body, restores forces, copies connected outputs, and restores forces
again. It publishes the output image after the last instance. A later instance can
therefore read an earlier instance's output through a global in the same run.
Unconnected inputs keep their values between runs and unconnected outputs are not
copied. All parameters are unconnected in an implicit configuration. Parameters
appear in snapshots and accept forces; connected inputs reject monitor writes with
`runtime.write-connected-input`, while unconnected parameters and connected outputs
accept writes.

## Located variables and direct connections

ADR 0016 defines I/Q areas of 64 bytes and M of 1,024 bytes. `X` binds BOOL;
`B` binds BYTE/SINT/USINT; `W` binds WORD/INT/UINT; `D` binds
DWORD/DINT/UDINT/REAL; `L` binds LWORD/LINT/ULINT/LREAL. Aliases of those types are
allowed; subranges, enumerations, aggregates, time/date, characters and strings
are rejected. Numeric indices count units: `%IW1` starts at byte 2, `%ID1` at
byte 4, `%IL1` at byte 8. `%IX3.5` selects bit 5 of byte 3.

`AT` is allowed on PROGRAM VAR and configuration/resource globals. It is rejected
in functions/FBs, on temporaries, externals, parameters and constants. Retention
qualifiers and partly specified addresses remain unsupported. Malformed or
hierarchical addresses produce `lex.malformed-direct-address`; invalid bounds
produce `decl.address-out-of-range`, and incompatible types produce
`decl.direct-address-type`. Connections use the same checks; outputs cannot
connect to I.

Overlapping Q writers (located declarations and direct output connections) emit
`decl.output-overlap` warnings, including separate instances. Independent bits in
the same byte do not overlap. I and M aliases produce no overlap warnings.

## Methods on function blocks

A function block declares methods after its variable sections and before its body.
Methods compile once into the block definition, with function-style parameter
checking and separate local slots. Overloaded standard block variants collect
selecting argument types across the body and every method before checking calls.
Calls accept formal or positional arguments as
user functions do, and can appear as statements or, with a result type, expressions.
The recursion graph includes methods as distinct nodes, including unreachable
methods and cycles through functions or block bodies. Member and method access is
checked by declaring type and namespace.

## Classes

`CLASS Name ... END_CLASS` groups persistent data and methods without a body.
It accepts `VAR` (access before CONSTANT/RETAIN/NON_RETAIN) and `VAR_EXTERNAL`.
Access defaults to PROTECTED; method scope, THIS, parameters, result types and
access checks are the same as for function blocks. Class statements must be in
methods. VAR_INPUT, VAR_OUTPUT, VAR_IN_OUT, VAR_TEMP and AT in a class are errors.

Instances are allowed in PROGRAM, function block and class VAR sections, globals,
and inline instance arrays. Parameters, structure members, temporaries, FUNCTION
and method locals, CONSTANT instances and instance initializers are rejected as
for function blocks. A class can contain block or class instances, but no direct
or indirect containment cycle is allowed. Class names join the shared namespace;
a variable with a class name reports `decl.name-collision` with kind `"type"`.
`v()` reports `class.not-callable`; call `v.Open()` instead. Definitions and methods
are shared in the IR, while each instance has independent storage.
Namespaces follow the source and lookup rules below.

## Inheritance (ADR 0017)

`compileProject` resolves the acyclic, same-kind `EXTENDS` graph before checking
members. It flattens inherited variable sections base first and builds effective
method slots, preserving each declaration's lexical owner. Overrides keep access,
parameter names, sections, types and order, and the result type. Abstract types
cannot be instantiated; concrete types must implement inherited abstract methods.

An empty derived function block body inherits the base's effective body; comments
are empty, whereas `RETURN;` replaces the body. A body containing statements
replaces it and can call `SUPER();`. Method calls through implicit or explicit
`THIS` dispatch using the instance's actual type; `SUPER.M()` selects the base
implementation. The recursion graph includes every possible descendant override
for a THIS call, and only the selected implementation for a SUPER call.

## Interfaces and assignment attempts

`compileProject` accepts INTERFACE sources alongside POUs. Interfaces may extend
multiple interfaces. The compiler resolves the acyclic interface graph before data
types and checks inherited prototypes and PUBLIC implementations after declaration
types resolve. IMPLEMENTS is inherited through class/function-block base types.
Concrete types must provide every prototype with an identical signature.

Interface variables default to NULL and accept only NULL initializers. They support
parameters, results, arrays, structures, globals and temporary storage, but cannot
be CONSTANT or located. Assignment accepts compatible interface values, NULL, THIS
and persistent implementing instances. Instance conversion preserves identity.
`target ?= source;` accepts interface variables and a NULL source and is never an
expression. Interface calls add recursion edges to every implementing method in
the project, conservatively rejecting composite forwarding cycles.

## References to instances (ADR 0017)

`REF_TO` accepts user function block and class types, including abstract base types.
Standard function blocks and interfaces remain invalid targets. `REF(inst)` and
`REF(THIS)` require persistent storage. Dereferences select members and methods;
`r^(...)` calls a function block body using its actual type. Classes remain
non-callable. Member and method access checks use the reference's declared type.

Derived references convert upward on assignment and parameter passing; downcasts
require `?=`. Assignment attempts accept interface variables, instance references
and NULL sources. Recursion edges include every possible derived method or body,
including inherited implementations, so unreachable dynamic cycles are rejected.

## Namespaces (ADR 0017)

Each source can wrap its one declaration in `NAMESPACE A.B ... END_NAMESPACE`.
`USING A, B.C;` appears before the declaration, just after the namespace header
when present. Configurations cannot have namespaces or imports; program instance
bindings accept qualified names such as `PROGRAM P WITH T : Plant.Main;`.

The namespace pass runs before inheritance and type checking. It qualifies names
of data types, POUs, bases, interfaces and function calls while retaining lexical
source spans. A qualified name always starts at the global namespace. A simple
name searches the own namespace, then enclosing namespaces, nearest first; if
none declares it, imports and the global namespace are searched together and
multiple matches are an error. Local variables take precedence at call sites.

`INTERNAL` after a declaration keyword restricts use to its namespace and
descendants. It requires a namespace. INTERNAL members and methods use the
declaring type's namespace; on a global type they remain project-wide. Namespace
roots reserve names throughout the project, qualified declarations cannot equal
namespaces, and standard simple declaration names remain reserved. Diagnostics
and monitor type names use qualified names; variable paths keep instance names.

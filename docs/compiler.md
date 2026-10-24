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

One configuration, one resource, one cyclic task and 1–64 program instances are
supported. `ON` accepts an arbitrary identifier and has no execution effect.
Every instance requires `WITH` and a known task; its type must name a `PROGRAM`.
The configuration, resource, task and instance names share a case-insensitive
namespace excluding POU, data type and standard names. Every POU is checked, even
when no instance references it; an uninstantiated PROGRAM has no storage and does
not execute.

`INTERVAL` and `PRIORITY` are both required, in either order. The interval is a
TIME/LTIME literal from 10 ms to 1 h in whole multiples of 10 ms; exact literal
arithmetic prevents rounding fractional values into range. Priority is an integer
literal from 0 to 65535. `INTERVAL`, `SINGLE` and `PRIORITY` remain ordinary
identifiers outside task parameter positions. Event tasks, multiple tasks, globals
and program connections remain deferred.

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

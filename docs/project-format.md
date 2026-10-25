# Project files

`@benchtop-plc/project` exposes a plain TypeScript `Project` and diagnostic-based
`readProject(xml)` / `writeProject(project)` results (`value` is null on errors).
Warnings can accompany a successful value. No filesystem, DOM or Node globals are
used by the package, so its built ESM also runs in a Web Worker.

The model includes file/content header metadata, an ordered `dataTypes: string[]`
(each text contains exactly one `TYPE Name : ...; END_TYPE`) before the ordered
`pous: string[]` (each text contains exactly one `PROGRAM`, `FUNCTION` or
`FUNCTION_BLOCK`), the `configuration`, `resource`, `task` and optional `instance`
fields for the implicit configuration, an optional `configurationSource: string`,
and a JSON panel layout. A configuration source takes precedence over the implicit
fields when saving and compiling. Task intervals use ISO 8601
fixed durations such as `PT0.01S`; task priority is 0–65535. Writing binds the
instance to the first `PROGRAM` in project order, retaining its instance name
(or using `mainInstance` for a new binding). With no program, the instance is
omitted. For implicit imports, an instance's `typeName` must name a `PROGRAM` of the file
(case-insensitively). Explicit configurations retain unknown types for compilation. Graphical coordinate scaling is fixed at 1 for FBD, LD and
SFC; graphical bodies are unsupported.

`splitProgram` uses the compiler POU parser and lexer spans to convert each editor
text to the standard's interface and ST body; `joinProgram` constructs canonical
POU text for imported files. Both functions support all three POU kinds despite
their historical names. Each `<pou>` has `pouType="program"`, `"function"` or `"functionBlock"`.
A function's optional result type is stored in `interface/returnType`. Local,
input, output, in-out and temporary sections map to `localVars`, `inputVars`,
`outputVars`, `inOutVars` and `tempVars`, preserving declaration order, including repeated sections. Grouped
names, scalar and derived types, direct addresses and initializer text keep their
existing mapping. User and standard FB instances use `<derived name="LATCH"/>`
types, including nested instances. Derived type names are written in upper case
and matched case-insensitively on read. ST bodies use an XHTML `p` element as
required by TC6's `formattedText`.

Saving requires each data type, POU and configuration source to parse and each initializer to pass the
compiler's initializer checks with the project's data types in scope. POU
initializers also see earlier constants in their own POU context. The same checks
apply to imports. An unresolved name or declaration type does not block exchange, while an initializer
value outside its declared type does. Other semantic errors, including unknown
calls, duplicate names, name clashes, zero or several programs, and supported
sections disallowed for a POU kind, are preserved for the compiler to report after
opening. Run still requires error-free compilation. VAR_TEMP in a FUNCTION and
AT in a FUNCTION_BLOCK remain exchangeable semantic errors. Variable sections
without a mapping remain unsupported (ADR 0014).

The web app retains every imported data type and POU and compiles them together.
Imported data type texts remain in project metadata through browser autosave and
save/open; the web app lists and edits them before the POUs. Older browser autosaves
without `dataTypes` migrate to an empty list. The POU list
selects the text to edit; saving preserves every text.
Parseable projects with semantic errors can be saved and opened without loading
invalid code into the runtime. Existing version 1 browser autosaves with a single
`program` metadata field migrate to `pous` on read.

Runtime XML parsing uses `saxes`: a DOM-free, namespace-aware JavaScript SAX
parser. A small plain-data tree supports the scoped TC6 reader. XML is emitted
with escaped text/attributes, including character references for CR and whitespace
that XML otherwise normalizes. DTDs are rejected, and XML nesting is limited to
128 elements. Unknown standard elements or attributes produce errors rather than
silently changing program behavior. Multiple resources/configurations are
unsupported; configuration sources can exchange several tasks.

Our `addData/data` records use `handleUnknown="discard"`:

- At the project root, `https://github.com/yasukei/benchtop-plc/ns/panel/1` contains
  a `panel` element in that namespace with `version="1"` or `version="2"`; its text is
  the JSON layout. Missing panel data imports as `null`.
- Inside each `<pou>`, `<dataType>` and `<configuration>`, `https://github.com/yasukei/benchtop-plc/ns/source/1`
  contains a `source` element in that namespace with `version="1"`; its text
  preserves that source's exact spelling, comments, grouping, whitespace and line
  endings. Each source has its own entry, so duplicate names remain unambiguous.
  Files written by 0.3.0 with a project-level source entry for a single program
  remain readable, including `examples/blink/project.xml` and
  `examples/running-light/project.xml`.

The standard interface and ST body remain authoritative: preserved source is
restored only if parsing it produces the same POU kind, name, result type,
declarations and exact body as the standard XML. For data types, the name, folded
base definition and initializer text must match. Stale source produces a warning
and canonical text is used for that source. Unknown vendor data, including data at
other nested locations, is warned about and dropped. Unsupported versions of our
own extensions return an error. A round trip preserves metadata, data type and
POU text order, exact sources and JSON layout. Other tools may remove source extensions; then
declaration formatting is rebuilt. Canonical imports add body separator line
breaks only when missing, so repeated exchanges do not accumulate blank lines.
Optional header fields set to `undefined` are omitted, just like absent fields;
empty strings remain explicit.

## Data type mapping

Each data type source maps to `types/dataTypes/dataType` with its declared `name`,
`baseType`, optional `initialValue/simpleValue`, and its own source extension
(ADR 0015). Supported base types are:

- Enumerations: `enum/values/value` entries keep each member's spelling and folded
  integer value; `enum/baseType` keeps the integer base (INT if omitted on import).
- Named subranges: `subrangeSigned` or `subrangeUnsigned`, according to the integer
  base, with `range lower="..." upper="..."` and `baseType`. Bounds are folded
  numbers, including exact 64-bit decimal bounds.
- Aliases: an elementary element or `derived name="..."` for another named type.

Anonymous subranges in variable declarations and function result types use the
same subrange XML inline. Earlier POU constants can supply their bounds. Exact
source preserves the original bound expressions; canonical imports use folded
limits and reconstruct TYPE declarations in XML order. Removing source extensions
preserves compiled IR apart from source spans.

Scalar type and variable defaults keep their initializer text in `simpleValue/@value`.
Checks see the whole project's type declarations, including forward aliases.
Out-of-range subrange values and numeric or wrong-type enum initializers block
save and open. An unresolved enum member, such as `State#Missing`, remains a
semantic error that can be exchanged, like an undeclared type. Other representable
semantic errors still belong to compilation.

`pointer` remains unsupported; structures are described below.
Files written by 0.4.0 with an empty `<dataTypes/>` import with `dataTypes: []`;
the blink, running-light and motor-starters example sources remain unchanged.

## Configuration mapping

Without a configuration source, saving writes the same single configuration,
resource, cyclic task and optional instance as 0.5.0. Existing files and bundled
examples remain implicit, retaining names, interval, priority and panel layout.

A configuration source maps to `instances/configurations/configuration/resource`.
Each task has `name`, `priority`, and either an ISO 8601 `interval` (for example
`PT0.01S`) or `single` with its input text (`gAck`, `%IX0.1`). Each program instance
is a `pouInstance` with `name` and `typeName` nested in its task. The configuration's
`addData` holds its exact source text, including resource type, comments, declaration
order and line endings. When XML disagrees with that source, `project.stale-source`
warns and canonical configuration text is rebuilt from the standard structure.
Equivalent ISO duration spellings compare by duration. Fractional TIME intervals
keep their exact duration in XML even though TIME storage truncates milliseconds;
nonintegral nanosecond intervals cannot be represented and are rejected.

A file without the source extension stays implicit only with exactly one cyclic
task (an `interval` and no `single`) and at most one instance, without globals.
Otherwise it receives generated configuration text, using `ON BENCHTOP` because TC6
stores no resource type. For example, an event task imports as
`TASK OnAck (SINGLE := %IX0.1, PRIORITY := 0);`. The legacy fields reflect the XML
configuration/resource and first cyclic task; if the first task is not cyclic,
the legacy task defaults to `Cyclic`, `PT0.01S`, priority 1. These fields do not
control an explicit configuration.

Exchange preserves representable semantic errors, including unknown task/type
names, missing `WITH`, duplicate names and multiple tasks, for compiler diagnostics.
TC6 cannot nest an instance under a nonexistent task: an unknown or missing `WITH`
is projected into the first task in XML while the source extension retains the
original binding and its error. Removing the extension loses that invalid binding.
Instances with no task declaration cannot be represented and are rejected.
Task literals must fit their scalar types; malformed sources and out-of-range
values cannot be saved. PROGRAM `VAR_INPUT` and `VAR_OUTPUT` map to `inputVars`
and `outputVars`, including initializers. TC6 v2.01 has no connection element:
parameter connections live only in the configuration source extension, which
preserves exact text through save/open. Other tools, or an import after removing
that extension, see unconnected instances. Connection syntax is validated on save, including rejecting empty lists and trailing commas;
representable semantic errors remain available for compiler diagnostics.
Resource-level `pouInstance`, `accessVars` and `configVars` are unsupported here.

The web app edits, compiles and runs configuration sources, preserves them through
save/open and browser autosave, and hides the implicit cycle control for them.

## Writer identity

The web app stamps `fileHeader.companyName` and `fileHeader.productName` as
`benchtop-plc`, and `fileHeader.productVersion` as the current app package version,
together on every save. It also omits `companyURL` and `productRelease`, because
these describe the same company and product, and benchtop-plc supplies neither.
All five fields are treated as one writer identity. This also applies to imported
projects from other tools, so foreign company URLs or release strings cannot be
paired with benchtop-plc's identity. This supports PLCopen interchange without
restricting which tool created the project (ADR 0006).

Saving preserves the imported `creationDateTime`, `contentDescription` and the
entire content header. New projects receive a creation timestamp when saved. The lower-level
`readProject` / `writeProject` codec preserves the supplied headers; writer
identity stamping is the web app's save policy.

## Official schema test

The official PLCopen TC6 v2.01 XSD can be obtained from the
[PLCopen downloads page](https://www.plcopen.org/downloads/), under
“PLCopen XML version 2.01 xsd file”. Its redistribution terms are not explicit,
so no schema is vendored or relicensed as part of this MIT repository.

`tests/conformance/project-xml.test.ts` downloads the TC6 v2.01 schema from an
[immutable mirror](https://github.com/mattsse/plcopen-xml-xcore/blob/850175ace865e35d771785a62f3b3d6b2ed10bc1/schema/tc6_xml_v201.xsd)
on first use, using `curl` (30 second limit). The SHA-256 is checked before use:
`ab1f43cdb29f134fff6037045d98e8d071e077bbb18f64a8d2e8b128bdc871d1`.
The cache is `node_modules/.cache/plcopen/tc6_xml_v201.xsd`; it is ignored by Git.
Set `PLCOPEN_XSD_PATH` to an existing copy with that checksum for offline runs.
Download failures, hash mismatches and schema violations fail the test; they do
not skip validation. `libxml2-wasm` is a development-only dependency providing real
XSD validation without a system libxml2 installation. The test validates projects
with enumerations, signed and unsigned subranges, aliases and their use in POUs,
as well as the reference program's generated XML. It also asserts rejection of
an invalid priority.
Run it with `pnpm test tests/conformance/project-xml.test.ts` (also part of the
normal `pnpm test` and CI). No network access is used by the project package.

Function and function block `VAR_IN_OUT` sections map to `interface/inOutVars`,
preserving declaration order and exact source text. Canonical imports without
source extensions reconstruct `VAR_IN_OUT` sections. As with other representable
sections, an in-out section on a PROGRAM can be exchanged but compilation reports
`pou.invalid-section`. In-out declaration initializers are also exchangeable
semantic errors (`decl.in-out-initializer`); their usual type and range checks
still apply on save and import.

`VAR CONSTANT` maps to `localVars constant="true"`. Constant and mutable groups
remain separate in declaration order, including repeated groups. Imports accept
the XML boolean forms `true`/`1` and `false`/`0`; an absent or false attribute
means ordinary variables. Canonical imports reconstruct `VAR CONSTANT` even
without preserved source. Initializer checks see earlier constants in the same
POU, so `VAR CONSTANT N : INT := 10; END_VAR VAR A : INT := N; END_VAR`
saves and reopens with its initializer expression intact. Invalid initializer
values still block exchange on both paths. Representable constant modifiers on
input, output, in-out or temporary sections are preserved as semantic errors;
compilation rejects them with `decl.constant-section`.

## Strings and characters

STRING and WSTRING declarations, TYPE aliases and function results use TC6
`string` and `wstring`. An explicit `[n]` is stored in `length="n"`; an omitted
length remains omitted and means 80. Lengths outside 1–1,024 are rejected.
TC6 v2.01 has no character type elements: CHAR and WCHAR use
`<derived name="CHAR"/>` and `<derived name="WCHAR"/>`, recognized on import as
benchtop-plc elementary types (ADR 0015). Other tools may not recognize this convention.

Initializers remain quoted ST text in `simpleValue/@value`, with XML escaping
applied separately from ST dollar escapes. The compiler validates width, character
count and capacity on save and open. Source extensions preserve exact declarations;
imports without extensions reconstruct equivalent types, capacities and defaults.

## Arrays

Anonymous and named arrays use TC6 `array`, one `dimension` with folded `lower`
and `upper` bounds per dimension, and recursive `baseType`. Initial values use
`arrayValue/value`, with `repetitionValue` for repeated single values and nested
`arrayValue` for nested arrays. Repeated groups expand in source order. Missing
trailing values remain omitted and take element defaults on compilation.

POU constants used in bounds are folded before XML emission. Source extensions
preserve exact declaration spelling and initializer grouping; imports without
extensions rebuild equivalent canonical ST. Scalar element types, including
bounded strings, enumerations and subranges, keep their existing mappings.

## Structures

A data type's TC6 `baseType/struct` contains ordered `variable` members with their
own `type` and optional `initialValue`. Named nested structures use `derived`;
arrays in members use `array`. Structure initializers use `structValue/value`,
where each value has a `member` attribute and a nested `simpleValue`, `arrayValue`
or `structValue`. Thus structures in arrays and arrays in structures preserve
partial initializers and member defaults without flattening the XML layout.

The source extension preserves exact text. Without it, imports reconstruct
canonical STRUCT declarations and named initializers with equivalent executable
IR. Unknown/repeated initializer members and invalid leaf values block save/open.
External changes to member declarations, defaults or nested initializers invalidate
stale preserved source. Conformance tests validate nested examples against TC6 v2.01.

## Function block arrays

Inline arrays of standard and user function blocks use TC6 `array` dimensions
with a `derived` base type, for example
`<array><dimension lower="1" upper="4"/><baseType><derived name="TON"/></baseType></array>`.
The same representation applies within user function block interfaces. Instance
arrays have no user initializer. Saving and opening preserve exact POU texts;
files without source extensions reconstruct equivalent declarations and indexed
call bodies through the canonical XML representation.

## Aggregate parameters and open arrays

Array and structure parameters use the same TC6 type encoding as local values in
`inputVars`, `outputVars` and `inOutVars`; aggregate function results use
`returnType`. Named arrays/structures use `derived`; inline arrays use `array`.
Whole-value initializers retain the existing `arrayValue`/`structValue` encoding.

`ARRAY[*]` is stored as `<array><dimension lower="*" upper="*"/><baseType>...</baseType></array>`.
Multiple open dimensions have one such `dimension` each. TC6 v2.01 bounds are
strings, so this ADR 0015 convention is schema-valid. Both bounds must be `*` for
an open dimension. The compiler restricts open arrays to direct VAR_IN_OUT
parameters; the XML codec preserves representable section errors for editing.
Source extensions preserve exact POU text, and files without them reconstruct
canonical open-array declarations and aggregate function result types.

## References

`REF_TO T` maps to `<pointer><baseType>…T…</baseType></pointer>` in TC6 v2.01,
including aliases, array elements, structure members and POU interfaces/results.
A pointer requires exactly one base type. Explicit `NULL` initializers use
`<initialValue><simpleValue value="NULL"/></initialValue>`; omitted initializers
remain omitted. Other reference initializers are rejected on save and open.
Source extensions preserve exact editor text; imports without them reconstruct
`REF_TO` syntax. Self-referencing structures are representable through named
pointer targets. This maps references only: pointer arithmetic, address functions
and allocation are unsupported.

## Global and external declarations

Configuration globals map to `configuration/globalVars`, resource globals to
`resource/globalVars`, and POU externals to `interface/externalVars`. Constant
sections carry `constant="true"`; groups retain declaration order. Variables use
the existing type, address and initialValue representations. Array bounds and
initializer repetition counts fold with earlier global constants or imported
external constants in scope.

The configuration source extension preserves exact global text. Without it, the
reader rebuilds configuration text whenever globals exist, even for one task and
one program. Standard XML remains authoritative when an initial value, type or
constant or retention attribute differs from the extension. Existing files
without globals open unchanged.

## Direct addresses and panel extension version 2

TC6 variable `address` attributes preserve I/Q/M addresses with X/B/W/D/L sizes,
on PROGRAM locals and globals. Exact source text and generated declarations
round trip these forms; size/type and area validity are compiler checks.

Panel version 1 uses `bit: n` for byte-zero controls. The web reader maps it to
`%IX0.n` for inputs and `%QX0.n` for lamps. Version 2 uses `address` strings on
every part, for example `"address": "%QX1.0"`; emergency stop uses `null`.
The writer emits version 1 with the original bit bindings whenever every part is
representable in byte zero, and version 2 otherwise. A 0.5.0 layout therefore saves
back as version 1. Older apps reject version 2 as `project.unsupported`.
Numeric parts always require version 2. A numeric input uses
`"kind": "numericInput"`, an input `address` (`%IB`, `%IW`, `%ID` or `%IL`),
`dataType`, and optional numeric `min`/`max` bounds. A numeric display uses
`"kind": "numericDisplay"`, an output `address` (`%QB`, `%QW`, `%QD` or `%QL`),
and `dataType`. Both have the usual `id`, fractional `x`/`y` position, and an
optional `label`; numeric parts do not need a color. The type must match its address
size as in ADR 0016. Bounds must fit the input type, with `min < max` when both
are present; displays have no bounds. For example:

```json
[
  {
    "id": "1",
    "kind": "numericInput",
    "x": 0.2,
    "y": 0.5,
    "address": "%IW0",
    "dataType": "INT",
    "min": -100,
    "max": 100,
    "label": "Setpoint"
  },
  {
    "id": "2",
    "kind": "numericDisplay",
    "x": 0.8,
    "y": 0.5,
    "address": "%QW0",
    "dataType": "INT",
    "label": "Actual"
  }
]
```

Removing numeric parts restores version 1 output if the remaining layout is
representable in it.

## Retention qualifiers

TC6 localVars, inputVars, outputVars and globalVars lists round trip RETAIN as
`retain="true"` and NON_RETAIN as `nonretain="true"`. Boolean attributes accept
true/false and 1/0; malformed values are project.invalid. Groups separate when
qualifiers differ, preserving declaration order. The source extension preserves
exact spelling; without it, generated ST includes the corresponding qualifiers.
A disagreement between XML qualifiers and a source extension reports
project.stale-source and uses the XML structure. Compilation separately rejects
illegal qualifier combinations and sections. These attributes describe storage
semantics; live retained values stay in browser autosave and are not project data.

## Methods and older reserved identifiers

A block with methods writes its own declarations and body to TC6's standard
`functionBlock` POU; methods and access specifiers exist only in its exact source
extension. Reopening compares the standard declarations and body without methods
or access, then restores the exact source. Other tools see the block without its
methods, and removing the extension loses the methods.

A 0.6.0 text that fails current parsing but parses with the previous keyword set
opens as an editable draft. Its preserved source wins when present; otherwise the
standard elements generate the draft. This applies to POUs, data types and
configuration text, preserving resource type names and parameter connections.
Draft data types remain unknown while reading other texts, which keep their exact
source. Other damaged preserved text still falls back with `project.stale-source`;
invalid XML, unsupported elements and invalid initializers still reject the file.
Drafts cannot be exported until their reserved names are renamed.

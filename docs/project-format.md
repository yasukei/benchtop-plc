# Project files

`@benchtop-plc/project` exposes a plain TypeScript `Project` and diagnostic-based
`readProject(xml)` / `writeProject(project)` results (`value` is null on errors).
Warnings can accompany a successful value. No filesystem, DOM or Node globals are
used by the package, so its built ESM also runs in a Web Worker.

The model includes file/content header metadata, an ordered `dataTypes: string[]`
(each text contains exactly one `TYPE Name : ...; END_TYPE`) before the ordered
`pous: string[]` (each text contains exactly one `PROGRAM`, `FUNCTION` or
`FUNCTION_BLOCK`), one configuration,
one resource, one positive fixed-duration cyclic task, an optional program
instance bound to that task, and a JSON panel layout. Task intervals use ISO 8601
fixed durations such as `PT0.01S`; task priority is 0–65535. Writing binds the
instance to the first `PROGRAM` in project order, retaining its instance name
(or using `mainInstance` for a new binding). With no program, the instance is
omitted. On import, an instance's `typeName` must name a `PROGRAM` of the file
(case-insensitively). Graphical coordinate scaling is fixed at 1 for FBD, LD and
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

Saving requires each data type and POU to parse and each initializer to pass the
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
save/open; listing and editing them is deferred to #122. Older browser autosaves
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
silently changing program behavior. Multiple resources/tasks/configurations are
unsupported.

Our `addData/data` records use `handleUnknown="discard"`:

- At the project root, `https://github.com/yasukei/benchtop-plc/ns/panel/1` contains
  a `panel` element in that namespace with `version="1"`; its text is the JSON
  layout. Missing panel data imports as `null`.
- Inside each `<pou>` and `<dataType>`, `https://github.com/yasukei/benchtop-plc/ns/source/1`
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

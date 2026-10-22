# Project files

`@benchtop-plc/project` exposes a plain TypeScript `Project` and diagnostic-based
`readProject(xml)` / `writeProject(project)` results (`value` is null on errors).
Warnings can accompany a successful value. No filesystem, DOM or Node globals are
used by the package, so its built ESM also runs in a Web Worker.

The model includes file/content header metadata, an ordered `pous: string[]`
(each text contains exactly one `PROGRAM`, `FUNCTION` or `FUNCTION_BLOCK`), one configuration,
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
input, output and temporary sections map to `localVars`, `inputVars`,
`outputVars` and `tempVars`, preserving declaration order, including repeated sections. Grouped
names, scalar and derived types, direct addresses and initializer text keep their
existing mapping. User and standard FB instances use `<derived name="Latch"/>`
types, including nested instances. ST bodies use an XHTML `p` element as required by TC6's
`formattedText`.

Saving requires each POU to parse and each initializer to pass the compiler's
initializer checks in its POU context. The same checks apply to imports. An
unresolved name or declaration type does not block exchange, while an initializer
value outside its declared type does. Other semantic errors, including unknown
calls, duplicate names, name clashes, zero or several programs, and supported
sections disallowed for a POU kind, are preserved for the compiler to report after
opening. Run still requires error-free compilation. VAR_TEMP in a FUNCTION and
AT in a FUNCTION_BLOCK remain exchangeable semantic errors. `VAR_IN_OUT`, constant
sections, and variable sections without a mapping are
unsupported in this version; later issues extend the mapping (ADR 0014).

The web app retains every imported POU and compiles them together. The POU list
selects the text to edit; saving preserves every text.
Parseable projects with semantic errors can be saved and opened without loading
invalid code into the runtime. Existing version 1 browser autosaves with a single
`program` metadata field migrate to `pous` on read.

Runtime XML parsing uses `saxes`: a DOM-free, namespace-aware JavaScript SAX
parser. A small plain-data tree supports the scoped TC6 reader. XML is emitted
with escaped text/attributes, including character references for CR and whitespace
that XML otherwise normalizes. DTDs are rejected, and XML nesting is limited to
128 elements. Unknown standard elements or attributes produce errors rather than
silently changing program behavior. Multiple resources/tasks/configurations and structured types/initial values are
unsupported.

Our `addData/data` records use `handleUnknown="discard"`:

- At the project root, `https://github.com/yasukei/benchtop-plc/ns/panel/1` contains
  a `panel` element in that namespace with `version="1"`; its text is the JSON
  layout. Missing panel data imports as `null`.
- Inside each `<pou>`, `https://github.com/yasukei/benchtop-plc/ns/source/1`
  contains a `source` element in that namespace with `version="1"`; its text
  preserves that POU's exact spelling, comments, grouping, whitespace and line
  endings. Each POU has its own entry, so duplicate names remain unambiguous.
  Files written by 0.3.0 with a project-level source entry for a single program
  remain readable, including `examples/blink/project.xml` and
  `examples/running-light/project.xml`.

The standard interface and ST body remain authoritative: preserved source is
restored only if parsing it produces the same POU kind, name, result type,
declarations and exact body as the standard XML. Stale source produces a warning
and canonical text is used for that POU. Unknown vendor data, including data at
other nested locations, is warned about and dropped. Unsupported versions of our
own extensions return an error. A round trip preserves metadata, POU text order,
exact sources and JSON layout. Other tools may remove source extensions; then
declaration formatting is rebuilt. Canonical imports add body separator line
breaks only when missing, so repeated exchanges do not accumulate blank lines.
Optional header fields set to `undefined` are omitted, just like absent fields;
empty strings remain explicit.

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
XSD validation without a system libxml2 installation. The test both validates the
reference program's generated XML and asserts rejection of an invalid priority.
Run it with `pnpm test tests/conformance/project-xml.test.ts` (also part of the
normal `pnpm test` and CI). No network access is used by the project package.

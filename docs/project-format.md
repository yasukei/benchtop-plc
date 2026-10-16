# Project files

`@benchtop-plc/project` exposes a plain TypeScript `Project` and diagnostic-based
`readProject(xml)` / `writeProject(project)` results (`value` is null on errors).
Warnings can accompany a successful value. No filesystem, DOM or Node globals are
used by the package, so its built ESM also runs in a Web Worker.

The model includes file/content header metadata, editor program text, one
configuration, one resource, one positive fixed-duration cyclic task, one program
instance bound to that task, and a JSON panel layout. Task intervals use ISO 8601
fixed durations such as `PT0.01S`; task priority is 0–65535. The instance's
`typeName` must match the POU name (case-insensitively). Graphical coordinate
scaling is fixed at 1 for FBD, LD and SFC; graphical bodies are unsupported.

`splitProgram` uses the compiler parser and lexer spans to convert the editor's
textual POU to the standard's variable interface and ST body. `joinProgram`
constructs a canonical textual POU for imported files. Local VAR blocks, grouped
names, scalar type names, derived types, direct addresses and initializer text are
supported. Only syntactically valid programs can be saved. This is format
conversion, not semantic checking; the compiler's `check` remains responsible for
type/name validity and constant initializer rules. ST text is stored in an XHTML
`p` element as required by TC6's `formattedText`.

Runtime XML parsing uses `saxes`: a DOM-free, namespace-aware JavaScript SAX
parser. A small plain-data tree supports the scoped TC6 reader. XML is emitted
with escaped text/attributes, including character references for CR and whitespace
that XML otherwise normalizes. DTDs are rejected, and XML nesting is limited to
128 elements. Unknown standard elements or attributes produce errors rather than
silently changing program behavior. Multiple POUs/resources/tasks/configurations,
nonlocal variables and structured types/initial values are unsupported.

Root `addData/data` records use `handleUnknown="discard"`:

- `https://github.com/yasukei/benchtop-plc/ns/panel/1`: a `panel` element in that
  namespace with `version="1"`; its text is the JSON layout. The initial model
  intentionally permits arbitrary JSON so this issue does not define the panel
  widget catalog. Missing panel data imports as `null`.
- `https://github.com/yasukei/benchtop-plc/ns/source/1`: a `source` element in that
  namespace with `version="1"`; its text preserves exact editor spelling,
  declaration comments, grouping, whitespace and line endings. The standard
  interface and ST body remain authoritative: the preserved source is restored
  only if parsing it produces the same name, declarations and exact body as the
  standard XML. Stale source produces a warning and canonical text is used.

Unknown vendor data, including nested `addData`, is warned about and dropped.
Unsupported versions of our own root extensions return an error. A project
round trip preserves metadata, exact editor source and JSON layout. Other tools
may remove the source extension; in that case declaration formatting is rebuilt.
Canonical imports add body separator line breaks only when missing, so repeated
exchanges do not accumulate blank lines. Optional header fields set to
`undefined` are omitted, just like absent fields; empty strings remain explicit.

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

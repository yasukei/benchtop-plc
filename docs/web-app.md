# Web workbench

Run `pnpm dev` to open the Vite development server. The left side displays an
editable Structured Text project with a POU list; the right side shows the operator panel, the
I/O image and the variable monitor. The layout becomes a single column below 760
px. The theme selector offers System (the default), Light and Dark. System
follows the operating system's color scheme, including live changes. An explicit
selection is saved in this browser's `localStorage`, like the language. The
shell and diagnostics support English and Japanese as required by ADR 0008; see
[i18n.md](i18n.md).

`main.tsx` creates a module Worker, a `RuntimeClient` and a plain TypeScript app
store, then restores saved work or opens the bundled blink example. React subscribes with
`useSyncExternalStore`. Runtime state and scan telemetry come from Worker
messages; the UI does not optimistically claim that RUN succeeded. Worker errors
terminate the connection, show a banner and disable runtime controls. Reload the
page to create a fresh connection.

`runtime.worker.ts` supplies `performance.now()` and `setInterval` as the runtime's
injected clock and ticker. `worker-host.ts` adapts the core protocol to the headless
runtime and sends state, snapshots and faults after commands and scheduled scans.
Changing the cycle reschedules the ticker without clearing memory or changing
operating state. Single scan is accepted only in STOP. Cold reset and load clear
the program's memory and input image; the runtime preserves an active emergency stop.
The host accepts emergency-stop messages from the operator panel and routes
scalar force/write commands to the debug API. Expected debug validation errors
produce a non-fatal `rejected` event instead of escaping the Worker listener.
The client forwards this event without terminating the connection. The store
keeps the latest rejection separately from PLC faults; the UI renders its reason
from the English/Japanese catalogs in a separate alert. Scan snapshots preserve
the alert until the next user command clears it. RUN, memory, forces and scan
counts continue through rejected commands.

The core protocol has no nullable fault message, so the store clears an old
diagnostic when it receives the zero-scan snapshot from load, cold reset or warm restart. It
retains a latched diagnostic through STOP requests and emergency-stop transitions.

## Browser autosave

Every POU, data type and configuration text (including code that does not compile), its last readable name and kind,
the selected source, panel layout, cycle time and
project metadata are saved to a versioned JSON record in `localStorage` 500 ms
after the last change. Pending changes are also saved when the page is hidden or
left. Reloading restores that work and loads compilable source into a fresh PLC
in STOP, with retained values restored, other memory initialized, no forces and no active emergency stop. Invalid
source stays in the editor with diagnostics until it is fixed and applied; it is
never run automatically. Missing, invalid or unsupported records, or unavailable
storage, fall back to the bundled example without blocking startup.

Version 4 stores separate data type and POU lists, an optional configuration and
the selected source. It migrates version 3 autosaves from 0.5.0 without changing
source text, names, selection, layout or cycle settings, and preserves imported
configuration text in older metadata. It also migrates version 2 autosaves from 0.4.0 with every POU and selection intact,
and version 1 autosaves from 0.3.0 with the latest program draft even when it
cannot be parsed. Imported types in older project metadata are retained.

Autosave is a per-browser convenience. It is not shared between browsers or
devices, and browser settings or storage limits may prevent persistence. Use
**Save project** to keep or share a project. **Restore example** replaces the
current work and is autosaved like other edits. Runtime state is not saved;
retained values are saved as described below.

## Configuration source

The configuration appears after data types and before POUs. **Add configuration**
creates at most one source and selects it. Its template gives each project
`PROGRAM` an instance on one cyclic task, using the implicit project's names,
priority and selected cycle interval where possible. Generated names avoid the
POU and data type names. Edit the `CONFIGURATION` header to rename it; an unreadable
header keeps the last readable name. Located configuration diagnostics open that
source, and its squiggles stay out of POU and data type editors.

Task intervals come from the configuration source while it exists, so the cycle
selector is replaced by a localized task table showing each loaded task's run
count, last and maximum execution time (ms), and overrun count. Cyclic and event
tasks share the resource-wide RUN, STOP, single scan, reset and emergency stop controls. Deleting the source requires confirmation and
returns to the implicit configuration with the project names and cycle selector.
Like other source edits, adding, editing or deleting a configuration takes effect
when RUN applies the changes. Invalid changes leave the loaded PLC and monitor
intact. Configuration text survives autosave and PLCopen XML save/open, including
autosaved drafts that cannot yet be parsed.

The monitor shows one collapsible group per program instance, initially expanded.
Variable rows inside each group use relative paths such as `count` or `M1.RUNNING`;
the full path remains in the row's tooltip. Each instance has independent memory,
writes and forces. Inline values in a `PROGRAM` editor show its first instance in
resource declaration order, identified above the editor. A `PROGRAM` with no
instance shows no inline values. Instance selection is not yet available.

## POUs

Data types appear in their own group before the POUs, in project order, with a
`TYPE` label and diagnostic count. **Add data type** appends an enumerated type
such as `TYPE Type1 : (Idle, Running, Done); END_TYPE` and selects its text.
Generated names are unique across both groups, ignoring case. Edit the header to
rename a type; an unreadable header keeps its previous name. Deletion requires
confirmation. POUs that use a deleted type show diagnostics and cannot be run,
but saving and reopening still work. Data type text and order survive both
browser autosave and PLCopen XML save/open.

The list next to the editor shows each POU in project order with its kind
(`PROGRAM`, `FUNCTION` or `FUNCTION_BLOCK`) and diagnostic count. Select a POU to
edit its text. **Add function** appends a short `FUNCTION F1 : INT` template and
selects it. **Add function block** appends a `FUNCTION_BLOCK FB1` template with
BOOL input/output ports. Each name uses the first available number, ignoring case. Rename a
POU by editing its header. If the header is damaged, the list keeps the previous
name and kind until it becomes readable again. The PROGRAM cannot be added or
deleted through the list. Deleting a function or block requires confirmation.

The compiler checks the whole project on every edit and before RUN. The problems
list shows diagnostics from all POUs, data types and the configuration; selecting a located diagnostic
opens its source and selects the source span. Editor squiggles belong only to the
selected source. Inline runtime values appear only in the PROGRAM. Switching sources
does not reload the PLC; edits to any source become unapplied changes.

**Save project** and **Open project** preserve the ordered POU list and each exact
text in PLCopen XML. Semantic errors, including calls to a deleted function, do
not block saving or opening; they still block RUN. A text that cannot be parsed,
or an initializer the file format cannot represent, blocks saving and shows the
codec's diagnostic. Autosave still keeps those drafts. The variable monitor shows
persistent user FB scalar members under dotted paths such as `M1.RUNNING`; writes
and forces address them normally. Nested standard FBs retain their port summary.
PROGRAM user FB calls show outputs in declaration order as inline values.

Try the [motor starters example](../examples/motor-starters/) by selecting
`examples/motor-starters/project.xml` with **Open project**. Its POU list contains
`Main`, `MotorStarter` and `CanStart`: a program, a reusable function block with a
nested TON, and an interlock function. Press **RUN**, then **M1 START** or
**M2 START** on the panel. Each motor has a 500 ms start delay, a STOP button,
an OVERLOAD switch and STARTING/RUN/TRIP lamps. The interlock permits one active
motor at a time, including during its delay; simultaneous starts while idle give
motor 1 priority. STOP or overload clears the motor's latch and timer. Clear an
overload and press START again to restart. Save/reopen keeps all three POU texts
and the panel. The bundled startup example remains blink.

Try the [batch mixer example](../examples/batch-mixer/) to run one of three
recipes. Open `examples/batch-mixer/project.xml`, press **RUN**, select a recipe
with **STANDARD RECIPE** or **GENTLE RECIPE** (both OFF selects Quick; Gentle
wins if both are ON), then press and release **START**. The FILL VALVE, MIXER and
DRAIN VALVE lamps follow the timed steps; DONE stays on after completion.
The monitor shows `State` by enumeration name, `ActiveRecipe` as a recipe array
path, and `Status` as quoted text such as `'Quick: Mixing'`. Expand `RECIPES`
and its elements to inspect structure members. Selection is latched for a batch;
changing switches applies to the next START. The panel's STOP button aborts to
Idle, clears the reference and resets timers. A fresh START edge begins a complete
batch. Save/reopen preserves both TYPE texts, the PROGRAM, recipe initializers
and panel; runtime state is reset.

Try the [tank station example](../examples/tank-station/) for configurations,
tasks, globals and retention together. Open `examples/tank-station/project.xml`,
set SETPOINT (%) to 50 and both LEVEL inputs below 50, press **RUN**, wait for an
idle scan, then press and release **START 1** and **START 2**. Each pump fills
until its level reaches the shared setpoint; change the levels manually.
The panel **STOP TANKS** button disarms both tanks. A level of 90 trips a latched
alarm; lower the level, press **ACK**, then press START again to resume.
Control runs every 100 ms; statistics reads the pump flags in `%MW0` every
500 ms and publishes `ActivePumps` on `%QW3` (also visible under Stats in the monitor). ACK triggers an event task on a rising edge.
RUN 1 and RUN 2 display retained pump-on activation counts in units of 0.1 s,
saturating at 65,535. Warm restart and page reload preserve the counters and
disarm both tanks; press RUN to republish counts on the output words. Use toolbar
STOP before reloading to flush the latest retained values to browser storage.
Cold reset and opening a project initialize the counters. Save/reopen preserves
the configuration, all three PROGRAM texts and the panel; XML excludes live values.

Try the [sorting conveyor example](../examples/sorting-conveyor/) for classes,
interfaces, namespaces and retained function block counters together. Open
`examples/sorting-conveyor/project.xml`, press **RUN**, wait for an idle scan,
then press and release **START**. Hold **PART A** or **PART B** to light the
matching DIVERT lamp and count one part in that bin; release to retract the gate.
The belt stays running until **STOP BELT**; **RESET TOTALS** clears both bin counts.
The monitor shows `BinATotal` and `BinBTotal`. Expand `Actuators` to inspect the
interface targets, `Belt` for motor speed and the gates for diverter angles.
The same method call dispatches to the two derived device types. Warm restart
keeps counts and disarms the belt; press RUN to republish totals, then a fresh
START to resume. Save/reopen preserves all seven source texts, including namespace
wrappers and interface prototypes, and the panel; opening a project resets counts.

## Structured Text editor

A thin React wrapper owns a CodeMirror 6 editor controller. Highlighting is a
line-oriented tokenizer tolerant of incomplete input, with nested block comments,
keywords, elementary, declared data type and function block names, literals and direct addresses.
Hovering a variable shows its declared type, including named types and inline
subranges; standard function blocks show their resolved variant.
Keyword and elementary type classification comes from the compiler to keep it
in sync with the lexer. Enter indents ST blocks. Tab inserts two spaces at a
cursor or indents selected lines without replacing their code. Theme and language changes
reconfigure the existing editor without replacing its selection or undo history.

The store compiles all POUs, data types and the configuration 250 ms after the last edit. Diagnostics use the existing
English/Japanese catalog in both squiggle tooltips and a list; clicking a located
diagnostic selects and scrolls to its source span. Editing clears stale diagnostic
locations immediately. RUN compiles synchronously, so it also catches changes
made within the debounce interval. Invalid changes leave the loaded program alone.

When the source differs from the loaded program, the heading shows "Unapplied
changes" and inline values and fault highlights are hidden. RUN with changes loads
the new IR and cold-starts it, including when replacing a running program. RUN
without changes resumes existing memory. Single scan is disabled until changes
are applied. E-STOP and FAULT still require their existing recovery operations.

A load clears the displayed snapshot; queued nonzero-scan snapshots from the old
program are ignored until the Worker's zero-scan load snapshot arrives. Online
annotations are placed at the end of the statement's start line, including
multiline FB calls, in source-column order. BOOL values are badges, and other
values use core's IEC formatter. Runtime faults highlight their source line and
appear in the diagnostics list while the source matches.

## Browser tests

```sh
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

Playwright builds all packages and serves the production bundle on port 4173. The
tests exercise the actual bundled Worker: RUN/STOP, scans, reset, theme, narrow
layout, a Worker startup failure, non-fatal rejected debug commands, localized
editor diagnostics, indentation, source application, changing reference-program
values and runtime fault lines. CI installs Chromium and runs these tests; on
failure it uploads the HTML report and retained traces. On a machine with a
system Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable path
to use it instead of Playwright's downloaded browser.

The public demo on GitHub Pages is served from `/benchtop-plc/`. The `Pages`
workflow builds it with `pnpm --filter @benchtop-plc/web build:pages` (Vite's
`base` set to the sub-path, output in `packages/web/dist/pages`) on every push to
`main` and deploys it. `pnpm dev`, `pnpm build` and `pnpm test:e2e` keep using `/`.
`pnpm test:e2e:pages` builds the Pages bundle, serves it with `vite preview` at
`http://127.0.0.1:4174/benchtop-plc/` and runs `smoke.spec.ts` against it, so a
URL that ignores the sub-path fails CI.

Client and store unit tests use a fake Worker. Host tests use the real runtime
with its virtual clock and ticker, without React or a browser.

## Monitoring character data

The monitor and PROGRAM inline values show STRING/CHAR with single quotes and
WSTRING/WCHAR with double quotes, using ST dollar escapes. LINT 123 displays as
`123`; STRING `'123'` retains its quotes. String rows show their declared capacity
or alias name. Writes and forces require one complete quoted literal of the
matching width and accept `$` escapes. Unquoted text, trailing statements or
comments, malformed escapes, values beyond capacity and non-single-byte units in
STRING/CHAR are rejected without changing the value or an existing force.

The editor highlights each quoted literal as one token, including typed prefixes.
`(*` and `//` inside literals never start comments, and incomplete literals do not
put later lines into comment state.

## Array monitoring

Array variables appear as collapsible rows. Expanding one reveals scalar elements
under paths such as `V[1]`, `M1.A[2,1]` or nested rows such as `N[1]`. Expanded
scalar leaves are watched in the Worker; collapsing removes those watches. Forced
leaves remain visible and reported when their parent is collapsed. Write, Force
and Unforce act on individual leaves with the usual type/range checks.

PROGRAM inline values show scalar element stores; whole-array copies show no
scalar value. The tokenizer recognizes brackets and variable hovers show complete
array types, including nested dimensions.

## Structure monitoring

Structure variables appear as collapsible rows, including inside arrays and as
nested members. Expanding `PTS`, then `PTS[2]`, reveals scalar rows `PTS[2].X`
and `PTS[2].Y`. Paths are case-insensitive ST identities displayed in uppercase
for aggregate leaves. Each scalar member has its own write/force controls using
its declared type; invalid enum/subrange/string values are rejected as for other
scalars. A forced member stays visible when its parents collapse. Only visible
or forced aggregate leaves are watched. Whole-structure copies have no inline
scalar annotation; scalar member assignments retain normal inline values.

## Function block array monitoring

Instance arrays appear as collapsible array rows. Editor hovers show the selected
array element variant, including inside uninstantiated user function blocks. Standard elements keep their
block snapshot representation (`T[2]`, including output names and values). User
block members appear under paths such as `M[2].RUNNING`; nested instance arrays
keep the full parent path. Expanding the array watches its visible leaves.
Scalar user member writes and forces use their usual controls and affect the
same persistent state used by indexed calls. Forced members remain visible when
the array is collapsed. Inline values in PROGRAM show indexed call outputs;
function block bodies still have no inline values.

## Reference monitoring

The variable monitor displays a reference's type (`REF_TO Point`) and its target
path, or `NULL`. Reference rows have no write or force controls. Array elements
and structure members that contain references use the same display when expanded.
A value changed through `r^` is monitored at its target's existing path. Inline
assignment and POU call values also show reference paths or `NULL`. NULL faults
use the English/Japanese diagnostic catalog and navigate to the executing POU.

## Monitoring globals

The variable monitor shows configuration and resource globals together in an
initially expanded **Globals** group beside the program instance groups. Paths
keep the global's own name. Scalar leaves accept the existing write and force
controls; global arrays and structures use the existing expansion/watch behavior.
A forced leaf stays visible when its group is collapsed. Global constants have no
monitor rows. Configuration source editing, autosave and project save/open retain
global and external declarations and CONSTANT attributes.

## Direct address images and panel bindings

The I/O image lists only addresses used by loaded program declarations, parameter
connections, direct event-task inputs or the panel. It decodes each declaration/connection in its bound
type, so an INT input at `%IW0` displays a signed number. Several types may view
the same bytes. Memory variables appear in the variable monitor. Invalid
REAL/LREAL patterns display a localized invalid label and raw hex bits without
throwing or faulting the host.

Buttons/selectors can bind any `%IX0.0`–`%IX63.7` bit; lamps can bind any
`%QX0.0`–`%QX63.7` bit. The panel editor lists those addresses. Worker input
commands carry address strings and typed values, preserving neighboring bits.
Emergency stop masks every output immediately. Panel files read legacy bit
bindings and save version 1 when possible, otherwise address-based version 2.

Numeric inputs and displays bind the B/W/D/L sizes in the input and output areas,
respectively. Add a numeric part in **Edit panel**, select its type (which selects
its address size), then choose an address. New parts automatically select the first
address that does not overlap an existing panel binding in the same area, falling
back to the first address only when no free address remains. Separate bit controls
can share a byte. Explicit rebinding still permits overlapping views.
The supported types are BYTE/SINT/USINT,
WORD/INT/UINT, DWORD/DINT/UDINT/REAL and LWORD/LINT/ULINT/LREAL. Labels are optional.
Inputs use a number field; configure optional **Minimum** and **Maximum** bounds
with **Apply range**. Bounds must fit the type, and the minimum must be less than
the maximum when both are present. Both bounds enable a slider. Invalid input
is marked and rejected without changing the input image. Long integer fields
preserve all 64 bits. Numeric inputs are disabled when the Worker connection closes.
Displays use monitor formatting (including hex bit strings and invalid REAL/LREAL
patterns) and show zero outside RUN or under emergency stop. Numeric parts always
save in panel extension version 2; existing bit-only projects retain their previous
version selection.

## Retained values in the browser

Warm restart sits next to Cold reset and becomes Acknowledge fault in FAULT. It
always returns the operating state to STOP and preserves retained data. The
English and Japanese catalogs supply these controls and all retention warnings.

The Worker sends a complete retained set at most once per second as scan values
change, and immediately after commands that change storage or operating state and scans
that enter FAULT.
The page replaces the optional `retentive` array in the version 4 autosave record
immediately, preserving all editable sources alongside it. Reload can lose up to
about one second of changes. It compiles autosaved sources, loads and restores
values, and stays in STOP. A normal Apply, RUN with unapplied edits, Open project
or Restore example initializes all values as a program load.

When autosaved text does not compile, retained records remain in storage until
the first successful load. Missing or mismatched records leave defaults; an alert
lists the count and every affected path; the alert clears on the next successful
program load, warm restart or cold reset. Storage being unavailable or full raises
a warning without stopping the PLC. Retained values are local browser state and
are not embedded in project XML.

## Function block methods and import drafts

Method calls in PROGRAM bodies display inline return values like function calls.
Method bodies do not display inline values. The monitor includes instance members
regardless of access and supports their existing writes and forces; method locals
never appear. A method fault navigates to its owning function block's source.

Older project texts using a newly reserved method keyword as an identifier open
in the editor with parse diagnostics. RUN and file export remain blocked until the
text parses; autosave preserves the draft across reloads. Rename the identifier to
resume running and saving the project.

## Classes

**Add class** appends a uniquely named CLASS template with one empty PUBLIC Run
method and selects it. The source list labels it CLASS; editing, deletion and
autosave work as for function blocks, including incomplete class drafts.
A PROGRAM can declare an instance and call its methods. The monitor shows dotted
class members with the same value, write and force controls as block members,
regardless of access. Constants and method locals are absent. Class method results
in PROGRAM bodies have inline values; class method bodies do not. Save and reopen
preserve exact class text through the project source extension.

## Inherited instances

The source list recognizes ABSTRACT/FINAL class and function block headers and
shows the declared type name. Inherited scalar members appear under their instance
with their own dotted paths, base first and then each type's declaration order.
The monitor permits writes and forces regardless of member access, including
inherited PRIVATE members. Runtime errors inside inherited implementations select
the declaring type's source. Saving and reopening preserves exact inheritance
sources; editing is through the Structured Text editor.

## Interface sources and monitoring

The source list offers Add interface with a template containing one METHOD
prototype. Interface sources appear after data types and before the other POUs,
use the same editor and diagnostic navigation, and survive save/open and autosave.
Labels and interface diagnostics are available in English and Japanese. Interface
variables display their target instance path or NULL in the monitor and inline
values; reference rows offer no write or force controls.

## Monitoring instance references

`REF_TO Motor` and class reference rows show the target instance's path, including
array indices, or NULL. They have no write/force controls. The target's members
remain at their own monitor paths; calls and writes through references update
those values. Save/reopen preserves reference declarations and method/body call
text, and loading the project resets reference bindings to NULL. Invalid casts,
access and lifetime errors and NULL faults use the English/Japanese catalog.

## Namespaced sources

POU and data type lists derive qualified names from namespace wrappers, including
while editing a source that has body errors. USING before a declaration and
INTERNAL declaration qualifiers are recognized in source headers. For example,
`NAMESPACE Conveyor.Devices` with `CLASS INTERNAL Motor` is listed as
`Conveyor.Devices.Motor`. Runtime diagnostics select the matching qualified POU
or declaring method source. Monitor types display qualified names; variable paths
continue to use instance and member names. Namespace text survives autosave and
project save/reopen unchanged.

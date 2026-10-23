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
diagnostic when it receives the zero-scan snapshot from load or cold reset. It
retains a latched diagnostic through STOP requests and emergency-stop transitions.

## Browser autosave

Every POU and data type text (including code that does not compile), its last readable name and kind,
the selected source, panel layout, cycle time and
project metadata are saved to a versioned JSON record in `localStorage` 500 ms
after the last change. Pending changes are also saved when the page is hidden or
left. Reloading restores that work and loads compilable source into a fresh PLC
in STOP, with initialized memory, no forces and no active emergency stop. Invalid
source stays in the editor with diagnostics until it is fixed and applied; it is
never run automatically. Missing, invalid or unsupported records, or unavailable
storage, fall back to the bundled example without blocking startup.

Version 3 stores separate ordered data type and POU lists and the selected source.
It migrates version 2 autosaves from 0.4.0 with every POU and selection intact,
and version 1 autosaves from 0.3.0 with the latest program draft even when it
cannot be parsed. Imported types in older project metadata are retained.

Autosave is a per-browser convenience. It is not shared between browsers or
devices, and browser settings or storage limits may prevent persistence. Use
**Save project** to keep or share a project. **Restore example** replaces the
current work and is autosaved like other edits. Runtime state and `RETAIN` values
are not saved.

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
list shows diagnostics from all POUs and data types; selecting a located diagnostic
opens its source and selects the source span. Editor squiggles belong only to the
selected source. Inline runtime values appear only in the PROGRAM. Switching sources
does not reload the PLC; edits to any POU or data type become unapplied changes.

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

The store compiles all POUs and data types 250 ms after the last edit. Diagnostics use the existing
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

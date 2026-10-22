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

Every POU text (including code that does not compile), its last readable name and kind,
the selected POU, panel layout, cycle time and
project metadata are saved to a versioned JSON record in `localStorage` 500 ms
after the last change. Pending changes are also saved when the page is hidden or
left. Reloading restores that work and loads compilable source into a fresh PLC
in STOP, with initialized memory, no forces and no active emergency stop. Invalid
source stays in the editor with diagnostics until it is fixed and applied; it is
never run automatically. Missing, invalid or unsupported records, or unavailable
storage, fall back to the bundled example without blocking startup.

Version 2 stores the ordered POU list and migrates version 1 autosaves from
0.3.0, preserving the latest program draft even when it cannot be parsed.

Autosave is a per-browser convenience. It is not shared between browsers or
devices, and browser settings or storage limits may prevent persistence. Use
**Save project** to keep or share a project. **Restore example** replaces the
current work and is autosaved like other edits. Runtime state and `RETAIN` values
are not saved.

## POUs

The list next to the editor shows each POU in project order with its kind
(`PROGRAM`, `FUNCTION` or `FUNCTION_BLOCK`) and diagnostic count. Select a POU to
edit its text. **Add function** appends a short `FUNCTION F1 : INT` template and
selects it. **Add function block** appends a `FUNCTION_BLOCK FB1` template with
BOOL input/output ports. Each name uses the first available number, ignoring case. Rename a
POU by editing its header. If the header is damaged, the list keeps the previous
name and kind until it becomes readable again. The PROGRAM cannot be added or
deleted through the list. Deleting a function or block requires confirmation.

The compiler checks the whole project on every edit and before RUN. The problems
list shows diagnostics from all POUs; selecting a located diagnostic opens its
POU and selects the source span. Editor squiggles belong only to the selected
POU. Inline runtime values appear only in the PROGRAM. Switching POUs does not
reload the PLC; edits to any POU become unapplied changes.

**Save project** and **Open project** preserve the ordered POU list and each exact
text in PLCopen XML. Semantic errors, including calls to a deleted function, do
not block saving or opening; they still block RUN. A text that cannot be parsed,
or an initializer the file format cannot represent, blocks saving and shows the
codec's diagnostic. Autosave still keeps those drafts. The variable monitor shows
persistent user FB scalar members under dotted paths such as `M1.RUNNING`; writes
and forces address them normally. Nested standard FBs retain their port summary.
PROGRAM user FB calls show outputs in declaration order as inline values.

## Structured Text editor

A thin React wrapper owns a CodeMirror 6 editor controller. Highlighting is a
line-oriented tokenizer tolerant of incomplete input, with nested block comments,
keywords, elementary and function block types, literals and direct addresses.
Keyword and elementary type classification comes from the compiler to keep it
in sync with the lexer. Enter indents ST blocks. Tab inserts two spaces at a
cursor or indents selected lines without replacing their code. Theme and language changes
reconfigure the existing editor without replacing its selection or undo history.

The store compiles all POUs 250 ms after the last edit. Diagnostics use the existing
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

# Web app shell

Run `pnpm dev` to open the Vite development server. The left side displays a
read-only Structured Text demo; the right side reserves space for the operator
panel, I/O image and variable monitor. The layout becomes a single column below
760 px. The theme selector switches CSS custom properties between light and dark.
Editor and panel implementations remain separate issues. The shell and diagnostics
support English and Japanese as required by ADR 0008; see [i18n.md](i18n.md).

`main.tsx` creates a module Worker, a `RuntimeClient` and a plain TypeScript app
store, then sends the hard-coded `demoProgram` IR. React subscribes with
`useSyncExternalStore`. Runtime state and scan telemetry come from Worker
messages; the UI does not optimistically claim that RUN succeeded. Worker errors
terminate the connection, show a banner and disable runtime controls. Reload the
page to create a fresh connection.

`runtime.worker.ts` supplies `performance.now()` and `setInterval` as the runtime's
injected clock and ticker. `worker-host.ts` adapts the core protocol to the headless
runtime and sends state, snapshots and faults after commands and scheduled scans.
Changing the cycle reschedules the ticker without clearing memory or changing
operating state. Single scan is accepted only in STOP. Cold reset and load clear
the demo's memory and input image; the runtime preserves an active emergency stop.
The host accepts emergency-stop messages for the future operator panel. Force and
write commands explicitly fail until the runtime debug API is implemented.

The core protocol has no nullable fault message, so the store clears an old
diagnostic when it receives the zero-scan snapshot from load or cold reset. It
retains a latched diagnostic through STOP requests and emergency-stop transitions.

## Browser tests

```sh
pnpm exec playwright install --with-deps chromium
pnpm test:e2e
```

Playwright builds all packages and serves the production bundle on port 4173. The
tests exercise the actual bundled Worker: RUN/STOP, scans, reset, theme, narrow
layout and a Worker startup failure. CI installs Chromium and runs these tests;
on failure it uploads the HTML report and retained traces. On a machine with a
system Chromium, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable path
to use it instead of Playwright's downloaded browser.

Client and store unit tests use a fake Worker. Host tests use the real runtime
with its virtual clock and ticker, without React or a browser.

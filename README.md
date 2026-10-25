# benchtop-plc

A browser-based software PLC that aims at IEC 61131-3 compliance.

**Try it:** [yasukei.github.io/benchtop-plc](https://yasukei.github.io/benchtop-plc/) runs the latest
`main` in your browser, no installation needed.

See the [architecture overview](docs/architecture.md) for the package structure and design decisions.

## Development

Requirements: Node.js LTS (22 or later) and pnpm (the version is pinned in `package.json`;
run `corepack enable` to use it).

```sh
pnpm install
pnpm typecheck   # TypeScript, strict mode
pnpm lint        # ESLint, dependency direction (dependency-cruiser), Prettier check
pnpm test        # unit and conformance tests (Vitest)
```

GitHub Actions workflows are checked by zizmor in CI; run `uvx zizmor==1.31.1 .github/` locally.
Dependabot opens grouped npm and GitHub Actions update PRs monthly; major updates come one per PR.

Other scripts:

- `pnpm dev` – start the web app
- `pnpm build` – build every package
- `pnpm format` – format all files with Prettier
- `pnpm test:e2e` – end-to-end tests (Playwright)
- `pnpm test:e2e:pages` – smoke tests against the GitHub Pages build under `/benchtop-plc/`

The repository is a pnpm workspace. Packages live in `packages/` (`core`, `compiler`,
`runtime`, `project`, `web`); language conformance tests live in `tests/conformance/`.
Dependencies point inward, `web → compiler | runtime | project → core` (and
`project → compiler`); `pnpm lint` rejects imports in the other direction.

The web app opens the bundled blink example (or the work autosaved in this
browser), compiles it and runs it in a Web Worker. The
[blink](examples/blink/), [running light](examples/running-light/),
[motor starters](examples/motor-starters/), [batch mixer](examples/batch-mixer/)
and [tank station](examples/tank-station/)
reference projects include documented panel controls and virtual-time conformance traces. Motor starters reuses a
user-defined function block for two interlocked motors, with a nested TON start
delay and a shared function. Batch mixer combines an enumerated state machine,
an array of recipe structures, a recipe reference, timers and string status
messages. Tank station combines two parameterized PROGRAM instances, fast and slow
tasks, an alarm event task, shared globals, memory flags and retained pump run-time
counters with numeric panel controls. Load an example's XML with **Open project**. See
[the web app guide](docs/web-app.md) for the host boundary and browser tests.

Contributor and agent conventions are in [`AGENTS.md`](AGENTS.md).

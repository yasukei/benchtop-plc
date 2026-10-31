# benchtop-plc

A browser-based software PLC that aims at IEC 61131-3 compliance.

**Try it:** [yasukei.github.io/benchtop-plc](https://yasukei.github.io/benchtop-plc/) runs the latest
release in your browser, no installation needed.

See the [architecture overview](docs/architecture.md) for the package structure and design decisions.

## Development

Requirements: Node.js 26 or later (the CI major is pinned in `.node-version`) and
pnpm (the version is pinned in `package.json`). If using Corepack, install it
separately and run `corepack enable`; Node.js 26 does not bundle it.

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
- `pnpm build` – build every package; run before submitting a PR
- `pnpm --filter @benchtop-plc/web build:pages` – generate the GitHub Pages deployment artifact
- `pnpm format` – format all files with Prettier
- `pnpm test:coverage` – unit and conformance tests with V8 coverage for `packages/*/src`;
  run before and during refactoring to find untested paths. Open `coverage/index.html`
  for the HTML report. CI runs this in place of `pnpm test`, shows per-package totals
  in the job summary and keeps the `unit-test-coverage` artifact for seven days.
- `pnpm test tests/property` – bounded compiler and PLCopen XML property tests,
  also included in `pnpm test`; see [seeds, replay and longer runs](tests/property/README.md).
- `pnpm test:e2e` – end-to-end tests (Playwright); run for UI changes
- `pnpm test:e2e:pages` – smoke tests against the GitHub Pages build under `/benchtop-plc/`;
  run for build or base-path changes (builds the Pages artifact itself)
- `pnpm bench:runtime` – run for runtime execution changes; compare ordinary benchmark
  medians with the pre-resumable-execution baseline on the same machine and Node version.
  [ADR 0018](docs/adr/0018-debugging.md) permits at most 2× the baseline with no
  breakpoint set and no step pending. See [the benchmark procedure](docs/runtime.md#scan-time-benchmark)
  to reproduce the baseline; the command reports timings rather than enforcing the budget.

Before finishing any change, run `pnpm typecheck && pnpm lint && pnpm test`.
CI uses `pnpm test:coverage` and also runs `pnpm build` and both Playwright suites on every PR; run all of them
locally to reproduce CI. For workflow changes, also run the zizmor check above.

### Preparing a release

On a release branch, run `pnpm release:prepare <version>` (for example,
`pnpm release:prepare 0.9.0`). It updates the root and all workspace package
versions and every example's `productVersion`, moves the unreleased changelog
entries into a dated release section using today's UTC date, leaves an empty
`[Unreleased]` section and updates the comparison links.

Write the release summary in `CHANGELOG.md` manually, review the diff and date,
then run the verification commands above and open a release PR. The version
consistency test checks every package and example against the root version.
After merge, the maintainer creates the annotated tag and GitHub Release as
described in [ADR 0011](docs/adr/0011-versioning-changelog-and-releases.md).

### Playwright browser setup

After `pnpm install` on a fresh clone, install the browser versions matching the
locked Playwright dependency, then run the suites:

```sh
pnpm exec playwright install chromium firefox webkit
pnpm test:e2e
pnpm test:e2e:pages
```

Use `pnpm install --frozen-lockfile` to match CI's dependency installation.
On Linux, if browser system libraries are missing, use
`pnpm exec playwright install --with-deps chromium firefox webkit`. CI keeps
Chromium headless with `pnpm exec playwright install --with-deps --only-shell chromium`
and installs Firefox and WebKit with `pnpm exec playwright install --with-deps firefox webkit`.
For local runs without `CI` set, both suites build the app and start their own
preview server; CI builds before running `test:e2e`.

A container's preinstalled Chromium may differ from Playwright's expected version,
causing "Executable doesn't exist". Install the matching browser as above or point
both suites at the preinstalled browser's executable using an absolute path:

```sh
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium
pnpm test:e2e
pnpm test:e2e:pages
```

The override takes an executable file, not a directory, and applies only to
Chromium. Firefox and WebKit still use their Playwright-managed browsers. In a
container with only Chromium, install the other engines with
`pnpm exec playwright install --with-deps firefox webkit` for the full suite, or
explicitly run `pnpm test:e2e --project=chromium` to omit their shortcut checks
locally. The Pages suite always uses Chromium only. Unset the override to use
Playwright-managed Chromium again.

CI exercises the full suite in Chromium and the debugger shortcut scenarios in
Firefox and WebKit on `ubuntu-latest` (Linux); it does not exercise Windows or macOS.

### Workspace

The repository is a pnpm workspace. Packages live in `packages/` (`core`, `compiler`,
`runtime`, `project`, `web`); language conformance tests live in `tests/conformance/`.
Dependencies point inward, `web → compiler | runtime | project → core` (and
`project → compiler`); `pnpm lint` rejects imports in the other direction.

The web app opens the bundled blink example (or the work autosaved in this
browser), compiles it and runs it in a Web Worker. The
[blink](examples/blink/), [running light](examples/running-light/),
[motor starters](examples/motor-starters/), [batch mixer](examples/batch-mixer/),
[tank station](examples/tank-station/) and [sorting conveyor](examples/sorting-conveyor/)
reference projects include documented panel controls and virtual-time conformance traces. Motor starters reuses a
user-defined function block for two interlocked motors, with a nested TON start
delay and a shared function. Batch mixer combines an enumerated state machine,
an array of recipe structures, a recipe reference, timers and string status
messages. Tank station combines two parameterized PROGRAM instances, fast and slow
tasks, an alarm event task, shared globals, memory flags and retained pump run-time
counters with numeric panel controls. Sorting conveyor combines namespaced classes,
inheritance, method overrides, an interface array, a reference to an instance and
function block methods with retained bin totals. Load an example's XML with **Open project**. See
[the web app guide](docs/web-app.md) for the host boundary and browser tests.
Follow the [debugging walkthrough](docs/debugging.md) to inspect conveyor instances,
halt on a part arrival and step through the call stack.

Contributor and agent conventions are in [`AGENTS.md`](AGENTS.md).

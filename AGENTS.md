# AGENTS.md

## Overview
benchtop-plc is a browser-based software PLC that aims at IEC 61131-3 compliance.
Requirements and specifications live in GitHub issues; the issue is the source of truth.

Monorepo (pnpm workspaces, TypeScript):
- `packages/core`     – data types, tree-shaped IR, UI⇔runtime protocol, diagnostic codes
- `packages/compiler` – ST source → IR (no DOM)
- `packages/runtime`  – executes IR in scan cycles (no DOM)
- `packages/project`  – PLCopen XML (TC6) read/write (no DOM)
- `packages/web`      – React UI; the runtime runs in a Web Worker

Dependency direction: `web → compiler | runtime | project → core`. Never import upward.

Design decisions are recorded in `docs/adr/` (overview: `docs/architecture.md`). Follow them; to change one, add a new ADR that supersedes it.

## Commands
- `pnpm install` – install workspace dependencies; use `--frozen-lockfile` to match CI
- `pnpm dev` – start the web app
- `pnpm build` – build every package
- `pnpm --filter @benchtop-plc/web build:pages` – build the web app for GitHub Pages
- `pnpm typecheck` – check TypeScript in strict mode
- `pnpm lint` – ESLint, dependency direction (dependency-cruiser), Prettier check
- `pnpm test` – unit and conformance tests (Vitest)
- `pnpm test:coverage` – unit and conformance tests with V8 coverage; run to find untested package source paths before and during refactoring
- `pnpm test:e2e` – end-to-end tests (Playwright)
- `pnpm test:e2e:pages` – smoke tests against the GitHub Pages build under `/benchtop-plc/`
- `pnpm bench:runtime` – task-run timing benchmark for the ADR 0018 budget

## Conventions
- English only: code, comments, commit messages, PR descriptions, docs.
- TypeScript strict mode. No `any` without a comment explaining why.
- Keep logic out of React components; put it in plain TS modules with unit tests.
- Runtime code never reads the wall clock directly; use the injected `Clock`.
- The compiler emits diagnostic codes with arguments, never user-facing text.
- Every user-facing string goes through the i18n catalog (`en`, `ja`).
- Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`).
- One issue per PR. Reference it with `Closes #N`.
- Changes users can notice (the web app, accepted ST, the project file format, user docs) add an entry under `[Unreleased]` in `CHANGELOG.md` in the same PR (ADR 0011).

## Verification
Before finishing, `pnpm typecheck && pnpm lint && pnpm test` must pass.
- Run `pnpm build` before submitting a PR to check every package's production build, as CI does.
- UI changes: run `pnpm test:e2e`.
- Build or base-path changes: run `pnpm test:e2e:pages`. It runs
  `pnpm --filter @benchtop-plc/web build:pages` itself; use the latter alone to
  generate the deployment artifact, as the Pages workflow does.
- Runtime execution changes: run `pnpm bench:runtime` and compare each ordinary
  benchmark's median with a baseline on the same machine and Node version.
  [ADR 0018](docs/adr/0018-debugging.md) permits at most 2× the median before
  resumable execution when no breakpoint is set and no step is pending.
  See [the benchmark procedure](docs/runtime.md#scan-time-benchmark) for baseline
  reproduction; the benchmark reports timings rather than enforcing the budget.
- Workflow changes: run `uvx zizmor==1.31.1 .github/`, matching CI's workflow check.

CI runs typecheck, lint, unit/conformance tests with coverage, build and both Playwright suites
on every PR. Run that full set locally to reproduce CI.

### Playwright browser setup

On a fresh clone, use the Node.js and pnpm versions described in
[README.md](README.md#development), then install dependencies and the matching browser:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:e2e:pages
```

On Linux, if browser system libraries are missing, use
`pnpm exec playwright install --with-deps chromium`. CI uses
`pnpm exec playwright install --with-deps --only-shell chromium` because these
tests run headless. For local runs without `CI` set, both suites build and start
their own preview server; CI builds before running `test:e2e`.

If a container has a preinstalled Chromium of another version, Playwright may
report "Executable doesn't exist" because it expects its own browser revision.
Either install the matching browser as above or set the absolute path to the
existing browser executable (not its directory):

```sh
export PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium
pnpm test:e2e
pnpm test:e2e:pages
```

Both Playwright configurations honor this override. Unset it to return to the
Playwright-managed browser.

### Test coverage

- New behavior needs a test in the same PR.
- Language semantics: add a case under `tests/conformance/`.
- UI behavior: add or update a Playwright test in `packages/web/e2e/`.
- Language features: update `docs/compliance.md` in the same PR.

## Don'ts
- Don't add a dependency without stating why in the PR description.
- Don't change types in `packages/core` without updating every consumer in the same PR.
- Don't weaken, skip, or delete tests to make them pass.
- Don't go beyond the issue's scope; note follow-ups in the PR instead.

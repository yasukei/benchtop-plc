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
- `pnpm install`
- `pnpm dev` – start the web app
- `pnpm build`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test` – unit and conformance tests (Vitest)
- `pnpm test:e2e` – Playwright

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
- New behavior needs a test in the same PR.
- Language semantics: add a case under `tests/conformance/`.
- UI behavior: add or update a Playwright test in `packages/web/e2e/`.
- Language features: update `docs/compliance.md` in the same PR.

## Don'ts
- Don't add a dependency without stating why in the PR description.
- Don't change types in `packages/core` without updating every consumer in the same PR.
- Don't weaken, skip, or delete tests to make them pass.
- Don't go beyond the issue's scope; note follow-ups in the PR instead.

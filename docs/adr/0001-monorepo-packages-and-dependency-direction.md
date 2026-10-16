# 0001. Monorepo packages and dependency direction

- Status: Accepted
- Date: 2026-10-16

## Context
The PLC must run in the browser now and possibly on a device later. Language processing, execution, file formats and UI change at different rates and are implemented by coding agents in separate PRs.

## Decision
Use a pnpm workspace with the packages `core`, `compiler`, `runtime`, `project` and `web`. Dependencies point inward: `web → compiler | runtime | project → core` (`project` may also use `compiler` to parse declarations). Only `web` may use DOM APIs. The direction is enforced by lint.

## Consequences
The engine can be tested in Node and reused on a device. Shared contracts live in `core`, so changing them touches several packages and must be done in one PR. Some indirection is needed where the UI wants engine details.

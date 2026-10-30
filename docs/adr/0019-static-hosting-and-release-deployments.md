# 0019. Static hosting and release deployments

- Status: Accepted
- Date: 2026-10-31
- Extends: [0011](0011-versioning-changelog-and-releases.md)

## Context

The app runs entirely in the browser, including its runtime in a Web Worker, so
it needs only static hosting. GitHub Pages already hosts the public demo under
`/benchtop-plc/`, but deploying every push to `main` exposes unfinished milestone
work and can publish a commit whose CI fails. The public site should follow the
released versions recorded by ADR 0011.

[ADR 0018](0018-debugging.md) already relies on GitHub Pages' inability to send
the cross-origin isolation headers needed by `SharedArrayBuffer`. Hosting and
its constraints need an explicit decision.

## Decision

- Host the app as a static site on GitHub Pages under `/benchtop-plc/`. There is
  no application server and no configurable response headers for cross-origin
  isolation; features must work without `SharedArrayBuffer`.
- Publish the public site per release. The `Pages` workflow runs on GitHub
  Release `published` events and checks out the release's tag explicitly. Pushes
  to `main` do not trigger deployment.
- Keep `workflow_dispatch` with a required `ref` string and no default. An
  operator can re-deploy a release or deploy a hotfix tag by supplying its tag or
  commit. The workflow definition comes from the branch selected for the run;
  the build source comes from the `ref` input.
- Build with `pnpm --filter @benchtop-plc/web build:pages` and upload only
  `packages/web/dist/pages`. Keep workflow permissions at `contents: read`;
  grant only the deploy job `pages: write` and `id-token: write`, using the
  `github-pages` environment. Serialize deployments without cancelling a run
  already in progress.
- Configure the `github-pages` environment to allow release tags matching `v*`
  as well as `main`, so both release events and manual dispatches from `main`
  can deploy. These rules apply to the workflow run's ref, not the checkout ref;
  a pre-merge deployment test needs a temporary rule for its workflow branch,
  removed after the test.
- Extend ADR 0011's manual release procedure after merging the version PR:
  1. Confirm that CI passed on the merge commit before creating the annotated
     `vX.Y.Z` tag and publishing its GitHub Release.
  2. Publishing the Release starts `Pages`, which builds the tagged source and
     deploys it. Check that both the build and deploy jobs succeed, then open
     the public site and confirm it loads under `/benchtop-plc/`.
  3. If deployment fails, correct the cause and manually dispatch `Pages` from
     `main`, setting `ref` to the same release tag. Use the same procedure for
     an intentional hotfix deployment, supplying the hotfix tag.

## Consequences

- The public site follows published releases while development continues on
  `main`. An intentional manual deployment can override it until the next
  release is published.
- Publishing a Release becomes a deployment action. CI remains a prerequisite
  checked by the maintainer in the release procedure; this workflow does not
  add an automated CI dependency.
- Static hosting keeps operations small, but rules out server-side features and
  cross-origin isolation. Moving to a host with different capabilities needs a
  new ADR.
- There are no pull-request preview deployments or a separate public site for
  `main`.

# 0011. Versioning, changelog and releases

- Status: Accepted
- Date: 2026-10-18

## Context

Milestone 1 is complete, but the project has no version, no tag and no record of
changes. The five workspace packages are private and are not published to npm;
the only thing users run is the web app. This is a personal project, and the
maintainer wants to keep changing the language support, the project file format
and the internal contracts without promising backward compatibility yet.

## Decision

- The repository has one version. The root `package.json` and every package's
  `package.json` always carry the same version.
- Versions follow Semantic Versioning 2.0.0. While the major version is 0, any
  release may break compatibility, including project files, the IR and the
  UI–runtime protocol. When to release 1.0.0 is not decided; a later ADR will
  decide it.
- Each completed milestone is a minor release (Milestone 1 is 0.1.0, Milestone 2
  is 0.2.0). A release that contains only fixes is a patch release.
- `CHANGELOG.md` follows Keep a Changelog 1.1.0. A pull request that changes
  something users can notice (the web app, the accepted Structured Text, the
  project file format, user-facing docs) adds an entry under `[Unreleased]` in
  the same pull request. Changes to tests, refactoring and CI need no entry.
- A release is made by a pull request that moves the `[Unreleased]` entries into
  a new version section with the release date, updates the comparison links and
  sets every `package.json` version. After it is merged, the maintainer creates
  an annotated tag `vX.Y.Z` on the merge commit and a GitHub Release whose notes
  are that version's section.

## Consequences

- Users and contributors can see what changed in each release without reading
  the commit history.
- Every user-visible pull request has one more file to update; reviewers check
  it.
- Releases stay manual. That is cheap while releases are rare; automate it if it
  becomes a chore.
- Because 0.x makes no compatibility promise, old project files may stop loading
  after an upgrade. The changelog must say so when it happens.

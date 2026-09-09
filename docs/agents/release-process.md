# Release process

How a change gets from a branch to a tagged release. The mechanics were settled
well before this file existed — tags, the version in `package.json` — but they
lived only in commit messages and people's heads. This writes them down, and
adds the one part that was genuinely missing: a maintained changelog.

## The convention, in one line

**Every version bump adds a `CHANGELOG.md` section in the same commit.**

`tests/changelog.test.js` enforces it. If `package.json` says `0.3.0-beta` and
`CHANGELOG.md` has no `## 0.3.0-beta — <date>` section, the unit suite fails —
locally, before the PR, where the fix is a one-line edit.

## Why a changelog is a requirement here and not a nicety

Gantry has a class of user that no other release surface reaches: people who
run it without ever reading the repository. For them, `git log` is not somewhere
they go, merge commit messages are not written for them, and Azure DevOps work
items are usually behind an access boundary they don't have.

Every place this project's release history has historically lived is invisible
to exactly the people most likely to be holding an old build and wondering
whether their problem is already fixed. `CHANGELOG.md` ships in the repo root,
in plain prose, and is the only answer they have.

## Cutting a release

1. **Bump `package.json`** (and the matching `version` field in
   `package-lock.json` — there are two, the top-level one and the one under
   `packages[""]`).
2. **Add the `CHANGELOG.md` section**, newest at the top:

   ```markdown
   ## 0.3.0-beta — 2026-09-15

   ### Fixed

   - **One-line summary of what the user sees** (WI #NNN). Then the detail:
     what was broken, what it does now, and anything they need to do
     differently.
   ```

   Format is fixed and machine-checked: `## <version> — <YYYY-MM-DD>`, em dash
   (`—`), ISO date. Entries are unique, newest-first, never future-dated.
   Group under `### Added` / `### Changed` / `### Fixed` / `### Removed`.

   Write for someone running Gantry, not someone reading the diff. "A
   TLS-inspecting corporate proxy no longer breaks `install.cmd`" is the entry;
   "set NODE_USE_SYSTEM_CA in the install script" is the commit message.
   Reference the work item — it's where the full reasoning lives for anyone who
   *can* reach it.
3. **PR to `main`** as normal, work item linked.
4. **Tag the merge commit on `main`** and push it:

   ```bash
   git tag -a v0.3.0-beta <merge-commit> -m "v0.3.0-beta — <summary>"
   git push origin v0.3.0-beta
   ```

   The tag goes on the **merge commit on `main`**, matching every tag before it.
   Tagging the branch commit instead would mark code that isn't on `main`.

## The zip-release path

The trimmed, Git-free zip package for locked-down corporate Windows machines —
`azure-pipelines.zip-release.yml`, `install.cmd` and `run.cmd` — no longer lives
on `main`. It lives on the **`zip-release`** branch, cut from `main` at
`0.2.2-beta`. Nothing on `main` builds or ships a zip; if that path is picked
back up, it's that branch's history to continue.

## Version numbers

Currently `0.x.y-beta`. Nothing formal is promised by the numbers yet beyond
"bigger is newer" — the `-beta` suffix is doing the honest work of saying so.
When that changes, this section should say what the new rule is rather than
leaving people to infer it from the sequence.

## Two different things both called CHANGELOG.md

- `CHANGELOG.md` (repo root) — **this one.** Release notes for the Gantry
  application.
- `definitions/<id>/<n>/CHANGELOG.md` — release notes for a *design definition*
  version: modules renamed, sections restructured, fields moved. Read by
  `loadDefinitionChangelog` in `lib/definition.js` and surfaced in the app, for
  the people authoring content against that definition. Seeded automatically
  when a new version directory is created.

They have nothing to do with each other. A change to the `design` definition's
structure goes in the definition's changelog; a change to Gantry goes in the
root one. A change that is both gets an entry in each.

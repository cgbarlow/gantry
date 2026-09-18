## Communication style

Talk to the user like they're a product owner: focus on decisions, outcomes, and trade-offs rather than implementation mechanics. Lead with what changed and what it means, not how it was done.

## Issue tracker

This repo's issue tracker is GitHub Issues on `cgbarlow/gantry`, driven with the `gh` CLI. Conventions in `docs/agents/issue-tracker.md`.

Note the distinction: GitHub is where *this repo's own* work is tracked. Azure DevOps remains a first-class **Provider** that Gantry-the-product integrates with — see `CONTEXT.md` and `docs/adr/0037-provider-as-a-suite-one-per-workspace.md`. Don't confuse the two.

## Releases

If you change the version in `package.json`, add a matching `CHANGELOG.md` section in the same commit — `## <version> — <YYYY-MM-DD>`, newest at the top, written for someone running Gantry rather than someone reading the diff. `tests/changelog.test.js` fails the build otherwise.

Release tags go on the merge commit on `main` (never a branch commit). Full process in `docs/agents/release-process.md`.

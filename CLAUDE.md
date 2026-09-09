## Communication style

Talk to the user like they're a product owner: focus on decisions, outcomes, and trade-offs rather than implementation mechanics. Lead with what changed and what it means, not how it was done.

## Azure DevOps

This repo's issue tracker is Azure DevOps, org `Contoso-Production`, project `Default`.

Always pass `project: "Default"` explicitly on every Azure DevOps MCP tool call that accepts a `project` parameter — when it's omitted, the tool prompts the user to pick a project interactively, even though there's only one for this repo.

## Releases

If you change the version in `package.json`, add a matching `CHANGELOG.md` section in the same commit — `## <version> — <YYYY-MM-DD>`, newest at the top, written for someone running Gantry rather than someone reading the diff. `tests/changelog.test.js` fails the build otherwise.

Release tags go on the merge commit on `main` (never a branch commit) and fire the zip-release pipeline. Full process in `docs/agents/release-process.md`.

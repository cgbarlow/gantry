## Agent skills

### Issue tracker

Issues live as Azure DevOps work items (project `Default`, org `Contoso-Production`), tracked under Epic #34 ("gantry"). See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical role names, applied as `System.Tags` strings (Azure DevOps has no native label field). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Releases

Every version bump adds a `CHANGELOG.md` section in the same commit — enforced by `tests/changelog.test.js`. Tags go on the merge commit on `main`. See `docs/agents/release-process.md`.

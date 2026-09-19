## Agent skills

### Issue tracker

Issues live as GitHub issues in `cgbarlow/gantry`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default canonical label names. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Releases

Every version bump adds a `CHANGELOG.md` section in the same commit — enforced by `tests/changelog.test.js`. Tags go on the merge commit on `main`. See `docs/agents/release-process.md`.

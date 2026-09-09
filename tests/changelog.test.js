import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The convention these tests exist to enforce (docs/agents/release-process.md):
// every version bump adds a section to CHANGELOG.md in the same commit. A
// changelog nobody is *forced* to update is a changelog that silently stops
// being true after two releases — and this one has a real audience who cannot
// fall back to anything else: a zip-release install has no .git directory and
// its user typically has no Azure DevOps access, so merge-commit messages and
// work items (where this project's release history has lived until now) are
// both unreadable to them. CHANGELOG.md ships inside the zip precisely so it
// is the one place that always answers "what changed, and does the copy I'm
// holding have the fix in it?".
//
// Checking this in the unit suite rather than a pipeline-only step is
// deliberate: it fails locally, before the PR, where fixing it is a one-line
// edit rather than a re-run.

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// `## <version> — <YYYY-MM-DD>`, em dash, ISO date. Fixed shape so the entries
// stay machine-readable — a release-notes page or the app's own About screen
// could parse this later without anyone having to reformat five years of prose.
const ENTRY_RE = /^## (\S+) — (\d{4}-\d{2}-\d{2})$/gm

function entries() {
  return [...changelog.matchAll(ENTRY_RE)].map(([, version, date]) => ({ version, date }))
}

test('CHANGELOG.md has at least one release entry in the expected format', () => {
  const found = entries()
  assert.ok(
    found.length > 0,
    'no entries matched `## <version> — <YYYY-MM-DD>` — check the heading format, ' +
      'including the em dash (—, not a hyphen)'
  )
})

test('the current package.json version has a CHANGELOG.md entry', () => {
  const found = entries()
  const match = found.find((e) => e.version === pkg.version)
  assert.ok(
    match,
    `package.json is at ${pkg.version} but CHANGELOG.md has no "## ${pkg.version} — <date>" ` +
      `section (newest entry is ${found[0]?.version ?? 'none'}). Bumping the version and ` +
      'writing the entry belong in the same commit — see docs/agents/release-process.md.'
  )
})

test('the newest CHANGELOG.md entry is the current version', () => {
  const found = entries()
  assert.equal(
    found[0].version,
    pkg.version,
    `CHANGELOG.md is newest-first, so its top entry must be the current package.json ` +
      `version (${pkg.version}), not ${found[0].version}. A new entry goes above the ` +
      'previous one, never appended to the bottom.'
  )
})

test('CHANGELOG.md lists each version exactly once', () => {
  const versions = entries().map((e) => e.version)
  const duplicates = versions.filter((v, i) => versions.indexOf(v) !== i)
  assert.deepEqual(
    [...new Set(duplicates)],
    [],
    'a version appears more than once — amend the existing section rather than adding a second one'
  )
})

test('CHANGELOG.md entries are ordered newest-first by date', () => {
  const dates = entries().map((e) => e.date)
  const descending = [...dates].sort().reverse()
  assert.deepEqual(
    dates,
    descending,
    'entry dates must not increase as you read down the file — newest release at the top'
  )
})

test('every CHANGELOG.md entry carries a real, non-future date', () => {
  // Guards the copy-paste failure mode: duplicating the section above and
  // editing the version but not the date.
  const today = new Date().toISOString().slice(0, 10)
  for (const { version, date } of entries()) {
    assert.ok(
      !Number.isNaN(Date.parse(date)),
      `${version} has an unparseable date: ${date}`
    )
    assert.ok(date <= today, `${version} is dated ${date}, which is in the future`)
  }
})

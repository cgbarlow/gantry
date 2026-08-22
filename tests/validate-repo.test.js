import { test } from 'node:test'
import assert from 'node:assert/strict'
import { repoSlug } from '../web/lib/validateRepo.js'

// `repoSlug` is the pure, deterministic half of the setup wizard's stubbed
// validate(repoUrl) contract (#78) — the network-dependent half (checking
// the parsed slug against GET /api/instances) is covered end-to-end by
// tests/setup-wizard.playwright.test.js instead, since it needs a running
// server behind a real `fetch`.
test('repoSlug extracts the last path segment as the instance slug', () => {
  assert.equal(repoSlug('https://dev.azure.com/Contoso-Production/Default/_git/claims-modernisation'), 'claims-modernisation')
  assert.equal(repoSlug('https://dev.azure.com/Contoso-Production/Default/_git/examples/'), 'examples')
  assert.equal(repoSlug('https://github.com/org/repo.git'), 'repo')
  assert.equal(repoSlug('  https://dev.azure.com/org/project/_git/spaced  '), 'spaced')
})

test('repoSlug returns \'\' for a URL it cannot parse a repo name out of', () => {
  assert.equal(repoSlug(''), '')
  assert.equal(repoSlug('not a url'), '')
  assert.equal(repoSlug(undefined), '')
  assert.equal(repoSlug(null), '')
})

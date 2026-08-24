import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseRepoUrl, repoSlug } from '../web/lib/validateRepo.js'

// The pure, deterministic half of the setup wizard's real validate(repoUrl) contract (#94, under #88) — parsing a repo URL into its Azure DevOps location. The network-dependent half (asking the live repo-check route, `GET /api/azure-devops/repo-check`, #90, whether that location already holds instance data) is covered end-to-end by tests/setup-wizard.playwright.test.js instead, since it needs a running server, a fake Azure DevOps backend, and a real `apiFetch`/PAT-prompt flow behind a real browser.

test('parseRepoUrl parses the standard https://dev.azure.com/{organization}/{project}/_git/{repository} shape', () => {
  assert.deepEqual(parseRepoUrl('https://dev.azure.com/Contoso-Production/Default/_git/claims-modernisation'), {
    organization: 'Contoso-Production',
    project: 'Default',
    repository: 'claims-modernisation',
  })
  // A trailing slash is tolerated.
  assert.deepEqual(parseRepoUrl('https://dev.azure.com/Contoso-Production/Default/_git/examples/'), {
    organization: 'Contoso-Production',
    project: 'Default',
    repository: 'examples',
  })
  // Leading/trailing whitespace (e.g. from a copy-paste) is trimmed first.
  assert.deepEqual(parseRepoUrl('  https://dev.azure.com/org/project/_git/spaced  '), {
    organization: 'org',
    project: 'project',
    repository: 'spaced',
  })
  // Percent-encoded organisation/project names (e.g. "Team & Co") are decoded — Azure DevOps itself would encode these in a real repo URL.
  assert.deepEqual(parseRepoUrl('https://dev.azure.com/Team%20%26%20Co/My%20Project/_git/repo'), {
    organization: 'Team & Co',
    project: 'My Project',
    repository: 'repo',
  })
})

test('parseRepoUrl returns null for anything that is not the standard dev.azure.com shape', () => {
  assert.equal(parseRepoUrl(''), null)
  assert.equal(parseRepoUrl('not a url'), null)
  assert.equal(parseRepoUrl(undefined), null)
  assert.equal(parseRepoUrl(null), null)
  // A non-dev.azure.com base URL (on-premises Azure DevOps Server) is an explicit, known gap — out of scope, per #88/#94 — not silently reinterpreted as if it were dev.azure.com.
  assert.equal(parseRepoUrl('https://ado.internal.example.com/org/project/_git/repo'), null)
  // A GitHub (or any other non-Azure-DevOps host) URL never parses either, even though it superficially resembles a repo URL.
  assert.equal(parseRepoUrl('https://github.com/org/repo.git'), null)
  // Missing the "_git" segment, or missing a path segment entirely.
  assert.equal(parseRepoUrl('https://dev.azure.com/org/project/repo'), null)
  assert.equal(parseRepoUrl('https://dev.azure.com/org/_git/repo'), null)
  // A malformed percent-escape must not throw.
  assert.equal(parseRepoUrl('https://dev.azure.com/org/project/_git/%'), null)
})

test('repoSlug is the repository name a URL parses to, or \'\' if it does not parse', () => {
  assert.equal(repoSlug('https://dev.azure.com/Contoso-Production/Default/_git/claims-modernisation'), 'claims-modernisation')
  assert.equal(repoSlug('https://dev.azure.com/Contoso-Production/Default/_git/examples/'), 'examples')
  assert.equal(repoSlug('https://github.com/org/repo.git'), '')
  assert.equal(repoSlug('not a url'), '')
  assert.equal(repoSlug(undefined), '')
})

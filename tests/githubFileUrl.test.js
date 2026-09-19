import { test } from 'node:test'
import assert from 'node:assert/strict'
import { artefactFileUrl, commitUrl } from '../lib/githubFileUrl.js'

// #16 — the public-vs-GitHub-Enterprise-Server base-URL derivation is exercised here at the unit
// seam (it doesn't need a running server or fake provider); the HTTP-level seam
// (tests/serverGitHubAssetsAndRender.test.js) proves the same builders wired into a real render and
// citation, against the fake server's own non-default baseUrl.

test('artefactFileUrl against the public GitHub default (no baseUrl) links to github.com', () => {
  const url = artefactFileUrl({ owner: 'kcm', repository: 'design-repo' }, 'gantry-workspace/foo/assets/bar.png', 'main')
  assert.equal(url, 'https://github.com/kcm/design-repo/blob/main/gantry-workspace/foo/assets/bar.png')
})

test('artefactFileUrl against a GitHub Enterprise Server API root strips the /api/v3 suffix for the web link', () => {
  const url = artefactFileUrl(
    { owner: 'kcm', repository: 'design-repo', baseUrl: 'https://github.kiwicover.example/api/v3' },
    'gantry-workspace/foo/assets/bar.png',
    'main'
  )
  assert.equal(url, 'https://github.kiwicover.example/kcm/design-repo/blob/main/gantry-workspace/foo/assets/bar.png')
})

test('artefactFileUrl encodes owner, repository, branch and path segments', () => {
  const url = artefactFileUrl(
    { owner: 'k c m', repository: 'design repo' },
    'gantry-workspace/my slug/assets/a b.png',
    'feature/x y'
  )
  assert.equal(
    url,
    'https://github.com/k%20c%20m/design%20repo/blob/feature%2Fx%20y/gantry-workspace/my%20slug/assets/a%20b.png'
  )
})

test('commitUrl against the public GitHub default links to github.com', () => {
  const url = commitUrl({ owner: 'kcm', repository: 'design-repo' }, 'abc123def456')
  assert.equal(url, 'https://github.com/kcm/design-repo/commit/abc123def456')
})

test('commitUrl against a GitHub Enterprise Server API root strips the /api/v3 suffix', () => {
  const url = commitUrl({ owner: 'kcm', repository: 'design-repo', baseUrl: 'https://github.kiwicover.example/api/v3' }, 'abc123def456')
  assert.equal(url, 'https://github.kiwicover.example/kcm/design-repo/commit/abc123def456')
})

test('a caller-supplied non-default, non-enterprise baseUrl (e.g. a fake test server) is used verbatim', () => {
  const url = artefactFileUrl({ owner: 'kcm', repository: 'design-repo', baseUrl: 'http://localhost:12345' }, 'a.md', 'main')
  assert.equal(url, 'http://localhost:12345/kcm/design-repo/blob/main/a.md')
})

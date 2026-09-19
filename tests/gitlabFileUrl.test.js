import { test } from 'node:test'
import assert from 'node:assert/strict'
import { artefactFileUrl, commitUrl, mergeRequestUrl, issueUrl } from '../lib/gitlabFileUrl.js'

// #31 — the public-vs-self-hosted base-URL derivation, and the namespace-as-opaque-multi-segment-path
// handling (ADR-0041), are exercised here at the unit seam (no running server/fake provider needed).

test('artefactFileUrl against the public gitlab.com default (no baseUrl) links to gitlab.com', () => {
  const url = artefactFileUrl({ namespace: 'kcm', repository: 'design-repo' }, 'gantry-workspace/foo/assets/bar.png', 'main')
  assert.equal(url, 'https://gitlab.com/kcm/design-repo/-/blob/main/gantry-workspace/foo/assets/bar.png')
})

test('artefactFileUrl against a self-hosted GitLab CE/EE API root strips the /api/v4 suffix for the web link', () => {
  const url = artefactFileUrl(
    { namespace: 'kcm', repository: 'design-repo', baseUrl: 'https://gitlab.kiwicover.example/api/v4' },
    'gantry-workspace/foo/assets/bar.png',
    'main'
  )
  assert.equal(url, 'https://gitlab.kiwicover.example/kcm/design-repo/-/blob/main/gantry-workspace/foo/assets/bar.png')
})

test('artefactFileUrl keeps a multi-segment namespace (subgroups) as real path separators, not percent-encoded', () => {
  const url = artefactFileUrl(
    { namespace: 'engineering/platform/backend-services', repository: 'design-repo' },
    'gantry-workspace/foo/assets/bar.png',
    'main'
  )
  assert.equal(
    url,
    'https://gitlab.com/engineering/platform/backend-services/design-repo/-/blob/main/gantry-workspace/foo/assets/bar.png'
  )
})

test('artefactFileUrl encodes namespace segments, repository, branch and path segments', () => {
  const url = artefactFileUrl(
    { namespace: 'k c m/sub group', repository: 'design repo' },
    'gantry-workspace/my slug/assets/a b.png',
    'feature/x y'
  )
  assert.equal(
    url,
    'https://gitlab.com/k%20c%20m/sub%20group/design%20repo/-/blob/feature%2Fx%20y/gantry-workspace/my%20slug/assets/a%20b.png'
  )
})

test('commitUrl against the public gitlab.com default links to gitlab.com', () => {
  const url = commitUrl({ namespace: 'kcm', repository: 'design-repo' }, 'abc123def456')
  assert.equal(url, 'https://gitlab.com/kcm/design-repo/-/commit/abc123def456')
})

test('commitUrl against a self-hosted GitLab API root strips the /api/v4 suffix', () => {
  const url = commitUrl(
    { namespace: 'kcm', repository: 'design-repo', baseUrl: 'https://gitlab.kiwicover.example/api/v4' },
    'abc123def456'
  )
  assert.equal(url, 'https://gitlab.kiwicover.example/kcm/design-repo/-/commit/abc123def456')
})

test('mergeRequestUrl builds the -/merge_requests/<iid> convention', () => {
  const url = mergeRequestUrl({ namespace: 'kcm', repository: 'design-repo' }, 42)
  assert.equal(url, 'https://gitlab.com/kcm/design-repo/-/merge_requests/42')
})

test('issueUrl builds the -/issues/<iid> convention', () => {
  const url = issueUrl({ namespace: 'kcm', repository: 'design-repo' }, 7)
  assert.equal(url, 'https://gitlab.com/kcm/design-repo/-/issues/7')
})

test('a caller-supplied non-default, non-self-hosted baseUrl (e.g. a fake test server) is used verbatim', () => {
  const url = artefactFileUrl({ namespace: 'kcm', repository: 'design-repo', baseUrl: 'http://localhost:12345' }, 'a.md', 'main')
  assert.equal(url, 'http://localhost:12345/kcm/design-repo/-/blob/main/a.md')
})

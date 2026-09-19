import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRepoAssetFileRefs } from '../lib/assets.js'
import { resolveRepoAssetRefs } from '../web/lib/assetRefs.js'

// #16 — unit coverage for the citation option resolveRepoAssetFileRefs/resolveRepoAssetRefs gained:
// a GitHub-backed repo-asset cites the committed file's own web address (no separate `source` to
// author), while Azure DevOps and local-workspace repo-assets keep emitting no citation at all,
// unchanged, when the caller doesn't supply a citation builder.

test('resolveRepoAssetFileRefs emits no citation when citationUrl is omitted (Azure DevOps / local, unchanged)', () => {
  const md = 'before ![alt](assets/foo.png) after'
  const out = resolveRepoAssetFileRefs(md, 'slug-x', { instancesDir: '/tmp/instances' })
  assert.doesNotMatch(out, /Source:/)
})

test('resolveRepoAssetFileRefs emits a "Source: [assets/<name>](<url>)" citation when citationUrl is supplied', () => {
  const md = '![alt](assets/foo.png)'
  const out = resolveRepoAssetFileRefs(md, 'slug-x', {
    instancesDir: '/tmp/instances',
    citationUrl: (filename) => `https://github.example/owner/repo/blob/main/gantry-workspace/slug-x/assets/${filename}`,
  })
  assert.match(out, /\*Source: \[assets\/foo\.png\]\(<https:\/\/github\.example\/owner\/repo\/blob\/main\/gantry-workspace\/slug-x\/assets\/foo\.png>\)\*/)
})

test('resolveRepoAssetFileRefs omits the citation when citationUrl returns a falsy value for that filename', () => {
  const md = '![alt](assets/foo.png)'
  const out = resolveRepoAssetFileRefs(md, 'slug-x', { instancesDir: '/tmp/instances', citationUrl: () => null })
  assert.doesNotMatch(out, /Source:/)
})

test('resolveRepoAssetRefs (browser preview) emits no citation when resolveCitation is omitted', () => {
  const out = resolveRepoAssetRefs('![alt](assets/foo.png)', (f) => `/api/instance/assets/${f}/file`)
  assert.doesNotMatch(out, /Source:/)
})

test('resolveRepoAssetRefs (browser preview) emits a citation when resolveCitation is supplied', () => {
  const out = resolveRepoAssetRefs(
    '![alt](assets/foo.png)',
    (f) => `/api/instance/assets/${f}/file`,
    (f) => `https://github.example/owner/repo/blob/main/gantry-workspace/slug-x/assets/${f}`
  )
  assert.match(out, /!\[alt\]\(\/api\/instance\/assets\/foo\.png\/file\)/)
  assert.match(out, /\*Source: \[assets\/foo\.png\]\(<https:\/\/github\.example\/owner\/repo\/blob\/main\/gantry-workspace\/slug-x\/assets\/foo\.png>\)\*/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  listAtlassianDefinitionIds,
  listAtlassianDefinitions,
  loadAtlassianDefinition,
  isAtlassianDefinitionArchived,
  createBlankAtlassianDefinition,
  createAtlassianDraftVersion,
  writeAtlassianDefinitionVersion,
  publishAtlassianDefinitionVersion,
  archiveAtlassianDefinition,
  restoreAtlassianDefinition,
} from '../lib/definitionAtlassian.js'
import { withFakeBitbucketServer, BITBUCKET_OWNER, BITBUCKET_REPOSITORY, BITBUCKET_VALID_PAT } from './helpers/fakeBitbucketServer.js'

// #43 (ADR-0036, ADR-0037, ADR-0042) — direct-call coverage of lib/definitionAtlassian.js, the
// Bitbucket-backed twin of lib/definitionGitLab.js, against a real fake Bitbucket Cloud server. Exercises
// the module's own read (list/load) and write (create/save/publish/archive/restore) paths the same way
// they would be exercised by lib/libraryCache.js (read-only, for a library repo) or by a future
// workspace-definitions-editor route (mirroring GitLab's own #32), without depending on either — this
// module's own wiring into those callers is left to the ticket that actually needs it.

function options(baseUrl, overrides = {}) {
  return { atlassian: { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl, ...overrides } }
}

function withServer(files, fn) {
  return withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files }, fn)
}

const PUBLISHED_DEFINITION_YAML = `id: sample
version: 1
status: published
title: Sample
description: A sample definition
stages:
  - id: shape
    title: Shape
    purpose: Shape it
    gate: soap
    modules:
      - background
artefacts:
  - id: soap
    title: Solution on a Page
    template: templates/soap.md.tmpl
    gate: soap
    requires:
      - background
`

const BACKGROUND_MODULE_YAML = `id: background
title: Background
purpose: Why this exists
fields:
  - id: problem-statement
    title: Problem statement
    type: markdown
    required: true
`

function seededFiles() {
  return {
    '/definitions/sample/1/definition.yaml': PUBLISHED_DEFINITION_YAML,
    '/definitions/sample/1/modules/background.yaml': BACKGROUND_MODULE_YAML,
  }
}

test('listAtlassianDefinitionIds finds every definition with at least one version directory', async () => {
  await withServer(seededFiles(), async (baseUrl) => {
    const ids = await listAtlassianDefinitionIds(options(baseUrl))
    assert.deepEqual(ids, ['sample'])
  })
})

test('loadAtlassianDefinition reads a definition and only its referenced modules', async () => {
  await withServer(seededFiles(), async (baseUrl) => {
    const def = await loadAtlassianDefinition('sample', 1, options(baseUrl))
    assert.equal(def.id, 'sample')
    assert.equal(def.title, 'Sample')
    assert.equal(def.status, 'published')
    assert.equal(def.stages.length, 1)
    assert.equal(def.artefacts.length, 1)
    assert.ok(def.modules.has('background'))
    assert.equal(def.modules.get('background').title, 'Background')
  })
})

test('loadAtlassianDefinition throws a clear error when a referenced module is missing', async () => {
  await withServer({ '/definitions/sample/1/definition.yaml': PUBLISHED_DEFINITION_YAML }, async (baseUrl) => {
    await assert.rejects(
      () => loadAtlassianDefinition('sample', 1, options(baseUrl)),
      /references module "background", which does not exist at version 1/
    )
  })
})

test('listAtlassianDefinitions reports the latest published version and skips archived definitions unless asked', async () => {
  await withServer(seededFiles(), async (baseUrl) => {
    const rows = await listAtlassianDefinitions(options(baseUrl))
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'sample')
    assert.equal(rows[0].latestPublished, 1)

    await archiveAtlassianDefinition('sample', options(baseUrl))
    assert.equal(await isAtlassianDefinitionArchived('sample', options(baseUrl)), true)

    const rowsAfterArchive = await listAtlassianDefinitions(options(baseUrl))
    assert.equal(rowsAfterArchive.length, 0, 'archived definitions are excluded by default')

    const rowsIncludingArchived = await listAtlassianDefinitions(options(baseUrl), { includeArchived: true })
    assert.equal(rowsIncludingArchived.length, 1)
    assert.equal(rowsIncludingArchived[0].archived, true)

    await restoreAtlassianDefinition('sample', options(baseUrl))
    assert.equal(await isAtlassianDefinitionArchived('sample', options(baseUrl)), false)
  })
})

test('createBlankAtlassianDefinition creates a fresh draft v1 in one commit, and refuses a colliding id', async () => {
  await withServer({}, async (baseUrl) => {
    const result = await createBlankAtlassianDefinition('new-process', options(baseUrl), { title: 'New Process' })
    assert.equal(result.id, 'new-process')

    const def = await loadAtlassianDefinition('new-process', 1, options(baseUrl))
    assert.equal(def.title, 'New Process')
    assert.equal(def.status, 'draft')
    assert.deepEqual(def.stages, [])

    await assert.rejects(() => createBlankAtlassianDefinition('new-process', options(baseUrl)), /already exists/)
  })
})

test('createBlankAtlassianDefinition rejects an invalid slug', async () => {
  await withServer({}, async (baseUrl) => {
    await assert.rejects(() => createBlankAtlassianDefinition('a/b', options(baseUrl)), /Invalid slug/)
  })
})

test('the full draft lifecycle: create, new draft version, save a structure, publish', async () => {
  await withServer({}, async (baseUrl) => {
    const opts = options(baseUrl)
    await createBlankAtlassianDefinition('lifecycle', opts, { title: 'Lifecycle' })

    const structure = {
      title: 'Lifecycle',
      description: 'Exercises the full write path',
      stages: [{ id: 'shape', title: 'Shape', purpose: 'Shape it', gate: 'soap', modules: ['background'] }],
      artefacts: [{ id: 'soap', title: 'Solution on a Page', template: 'templates/soap.md.tmpl', gate: 'soap', requires: ['background'] }],
      modules: [
        {
          id: 'background',
          title: 'Background',
          purpose: 'Why this exists',
          fields: [{ id: 'problem-statement', title: 'Problem statement', type: 'markdown', required: true }],
        },
      ],
    }

    const saveResult = await writeAtlassianDefinitionVersion('lifecycle', 1, structure, opts)
    assert.equal(saveResult.problems, undefined)

    const saved = await loadAtlassianDefinition('lifecycle', 1, opts)
    assert.equal(saved.stages[0].modules[0], 'background')
    assert.ok(saved.modules.has('background'))

    const published = await publishAtlassianDefinitionVersion('lifecycle', 1, opts)
    assert.equal(published.problems, undefined)
    const rows = await listAtlassianDefinitions(opts)
    const row = rows.find((r) => r.id === 'lifecycle')
    assert.equal(row.latestPublished, 1)

    // A second draft version copies the published content forward verbatim.
    const draft2 = await createAtlassianDraftVersion('lifecycle', opts)
    assert.equal(draft2.version, 2)
    const v2 = await loadAtlassianDefinition('lifecycle', 2, opts)
    assert.equal(v2.status, 'draft')
    assert.equal(v2.title, 'Lifecycle')
  })
})

test('writeAtlassianDefinitionVersion refuses to write over a version that is not a draft', async () => {
  await withServer(seededFiles(), async (baseUrl) => {
    await assert.rejects(
      () => writeAtlassianDefinitionVersion('sample', 1, { stages: [], artefacts: [], modules: [] }, options(baseUrl)),
      /not a draft \(status: published\)/
    )
  })
})

test('writeAtlassianDefinitionVersion reports structural problems instead of writing anything', async () => {
  await withServer({}, async (baseUrl) => {
    const opts = options(baseUrl)
    await createBlankAtlassianDefinition('broken', opts)
    const structure = {
      title: 'Broken',
      stages: [{ id: 'shape', title: 'Shape', purpose: 'p', gate: 'soap', modules: ['missing-module'] }],
      artefacts: [],
      modules: [],
    }
    const result = await writeAtlassianDefinitionVersion('broken', 1, structure, opts)
    assert.ok(result.problems?.length > 0)
    assert.match(result.problems[0].message, /references module "missing-module"/)
  })
})

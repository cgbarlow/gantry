import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadDefinition,
  definitionVersionProjection,
  writeDefinitionVersion,
  publishDefinitionVersion,
  createDraftVersion,
  cloneDefinition,
} from '../lib/definition.js'
import {
  loadAzureDevOpsDefinition,
  writeAzureDevOpsDefinitionVersion,
  publishAzureDevOpsDefinitionVersion,
  createAzureDevOpsDraftVersion,
} from '../lib/definitionAzureDevOps.js'
import { loadGitHubDefinition, writeGitHubDefinitionVersion, publishGitHubDefinitionVersion, createGitHubDraftVersion } from '../lib/definitionGitHub.js'
import { loadGitLabDefinition, writeGitLabDefinitionVersion, publishGitLabDefinitionVersion, createGitLabDraftVersion } from '../lib/definitionGitLab.js'
import { loadAtlassianDefinition, writeAtlassianDefinitionVersion, publishAtlassianDefinitionVersion, createAtlassianDraftVersion } from '../lib/definitionAtlassian.js'
import { refreshLibraryRepo, libraryRepoDefinitionsDir } from '../lib/libraryCache.js'
import { addLibraryRepo } from '../lib/librarySettings.js'
import { cloneFromLibraryRepoMirror } from '../lib/definitionHome.js'
import { readWorkspaceVersionFolderFiles, promoteDefinitionVersionToRepo, promotionBranchName } from '../lib/definitionPromote.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/fakeGitLabServer.js'
import { withFakeBitbucketServer, BITBUCKET_OWNER, BITBUCKET_REPOSITORY, BITBUCKET_VALID_PAT } from './helpers/fakeBitbucketServer.js'

// #148 (spec #147, "Round trip first") — a Definition means the same thing after every lifecycle
// operation. One fixture sets every Definition key this codebase knows, including Stage/Artefact
// `copied-from`, an Artefact `filename`, select `options`/`multiple`/`default`, and the three keys the
// #147 engine tickets give behaviour to (`document-control`, `satisfies-gate`, `read-only-modules`),
// which are pass-through here. Each test drives one lifecycle operation — save, new draft, clone,
// publish, promote, each Provider's loader and write path, the Library cache — and asserts every key
// is still there afterwards, read back the way a caller would see it (the version projection the
// Definitions page and API serve).

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const ADO_REPOSITORY = 'fake-ado-repo'
const ADO_VALID_PAT = 'valid-ado-test-pat'

const STAGE_PROVENANCE = { definition: 'elsewhere', version: 2, element: 'stage:second' }
const ARTEFACT_PROVENANCE = { definition: 'elsewhere', version: 2, element: 'artefact:letter' }

function definitionYaml(id, { version = 1, status = 'draft' } = {}) {
  return `id: ${id}
version: ${version}
status: ${status}
title: Round Trip
description: Sets every definition key
stages:
  - id: first
    title: First
    purpose: The first stage
    gate: first-gate
    modules:
      - details
  - id: second
    title: Second
    purpose: The second stage
    gate: second-gate
    modules:
      - details
      - notes
    read-only-modules:
      - details
    copied-from:
      definition: elsewhere
      version: 2
      element: stage:second
artefacts:
  - id: brief
    title: Brief
    purpose: The internal brief
    template: templates/brief.md.tmpl
    gate: first-gate
    requires:
      - details
    filename: "{details.kind} - Brief"
  - id: letter
    title: Letter
    purpose: The audience letter
    template: templates/letter.md.tmpl
    gate: second-gate
    requires:
      - details.kind
      - notes
    filename: "{details.kind} - Letter - {today}"
    document-control: false
    satisfies-gate: false
    copied-from:
      definition: elsewhere
      version: 2
      element: artefact:letter
`
}

const DETAILS_MODULE_YAML = `id: details
title: Details
purpose: What the engagement is
fields:
  - id: kind
    title: Kind
    type: select
    required: true
    options:
      - Permanent
      - Fixed term
    default: Permanent
  - id: tags
    title: Tags
    type: select
    options:
      - Urgent
      - Internal
    multiple: true
`

const NOTES_MODULE_YAML = `id: notes
title: Notes
purpose: Anything else
fields:
  - id: body
    title: Body
    type: markdown
    required-at:
      - second-gate
`

function repoFiles(id, options) {
  return {
    [`/definitions/${id}/1/definition.yaml`]: definitionYaml(id, options),
    [`/definitions/${id}/1/modules/details.yaml`]: DETAILS_MODULE_YAML,
    [`/definitions/${id}/1/modules/notes.yaml`]: NOTES_MODULE_YAML,
  }
}

function writeLocalFixture(definitionsDir, id, options) {
  const dir = join(definitionsDir, id, '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  writeFileSync(join(dir, 'definition.yaml'), definitionYaml(id, options))
  writeFileSync(join(dir, 'modules', 'details.yaml'), DETAILS_MODULE_YAML)
  writeFileSync(join(dir, 'modules', 'notes.yaml'), NOTES_MODULE_YAML)
}

function withScratch(fn) {
  const root = mkdtempSync(join(tmpdir(), 'defs-148-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  mkdirSync(definitionsDir)
  mkdirSync(instancesDir)
  return Promise.resolve(fn({ definitionsDir, instancesDir })).finally(() => rmSync(root, { recursive: true, force: true }))
}

// Every key, as the version projection presents it. Projections carry the two Artefact booleans only
// when they are `false` (the default is true), so an Artefact that doesn't set them has no such key.
function assertEveryKey(projection, where) {
  const byId = (list, id) => list.find((x) => x.id === id)
  const first = byId(projection.stages, 'first')
  const second = byId(projection.stages, 'second')
  assert.deepEqual(second.modules, ['details', 'notes'], where)
  assert.deepEqual(second.readOnlyModules, ['details'], `${where}: stage read-only-modules`)
  assert.deepEqual(second.copiedFrom, STAGE_PROVENANCE, `${where}: stage copied-from`)
  assert.equal('readOnlyModules' in first, false, `${where}: a stage without read-only-modules has no such key`)
  assert.equal('copiedFrom' in first, false, where)

  const brief = byId(projection.artefacts, 'brief')
  const letter = byId(projection.artefacts, 'letter')
  assert.equal(brief.filename, '{details.kind} - Brief', `${where}: artefact filename`)
  assert.equal('documentControl' in brief, false, `${where}: document-control omitted unless false`)
  assert.equal('satisfiesGate' in brief, false, `${where}: satisfies-gate omitted unless false`)
  assert.equal(letter.filename, '{details.kind} - Letter - {today}', `${where}: artefact filename`)
  assert.equal(letter.documentControl, false, `${where}: artefact document-control`)
  assert.equal(letter.satisfiesGate, false, `${where}: artefact satisfies-gate`)
  assert.deepEqual(letter.copiedFrom, ARTEFACT_PROVENANCE, `${where}: artefact copied-from`)

  const details = byId(projection.modules, 'details')
  const kind = byId(details.fields, 'kind')
  const tags = byId(details.fields, 'tags')
  assert.deepEqual(kind.options, ['Permanent', 'Fixed term'], `${where}: select options`)
  assert.equal(kind.default, 'Permanent', `${where}: select default`)
  assert.equal('multiple' in kind, false, where)
  assert.deepEqual(tags.options, ['Urgent', 'Internal'], `${where}: select options`)
  assert.equal(tags.multiple, true, `${where}: select multiple`)
  const body = byId(byId(projection.modules, 'notes').fields, 'body')
  assert.deepEqual(body.requiredAt, ['second-gate'], `${where}: required-at`)
}

function assertKebabKeysOnDisk(definitionYamlText, where) {
  assert.match(definitionYamlText, /read-only-modules:/, where)
  assert.match(definitionYamlText, /document-control: false/, where)
  assert.match(definitionYamlText, /satisfies-gate: false/, where)
  assert.match(definitionYamlText, /copied-from:/, where)
  assert.doesNotMatch(definitionYamlText, /readOnlyModules|documentControl|satisfiesGate|copiedFrom/, where)
}

function localProjection(id, version, definitionsDir) {
  return definitionVersionProjection(loadDefinition(id, { definitionsDir, version }))
}

// ---------- Local library / server workspace (lib/definition.js) ----------

test('every key survives load, web-editor save, publish, new draft version and clone', () =>
  withScratch(({ definitionsDir }) => {
    writeLocalFixture(definitionsDir, 'roundtrip')
    assertEveryKey(localProjection('roundtrip', 1, definitionsDir), 'load')

    // Web-editor save: the editor PUTs back the projection it was served.
    const saved = writeDefinitionVersion('roundtrip', 1, localProjection('roundtrip', 1, definitionsDir), { definitionsDir })
    assert.equal(saved.problems, undefined, JSON.stringify(saved.problems))
    assertEveryKey(saved, 'save (returned projection)')
    assertEveryKey(localProjection('roundtrip', 1, definitionsDir), 'save (reloaded)')

    const published = publishDefinitionVersion('roundtrip', 1, { definitionsDir })
    assert.equal(published.problems, undefined, JSON.stringify(published.problems))
    assert.equal(published.status, 'published')
    assertEveryKey(published, 'publish')
    assertKebabKeysOnDisk(readFileSync(join(definitionsDir, 'roundtrip/1/definition.yaml'), 'utf8'), 'publish')

    const { version } = createDraftVersion('roundtrip', { definitionsDir })
    assertEveryKey(localProjection('roundtrip', version, definitionsDir), 'new draft version')

    cloneDefinition('roundtrip', 'roundtrip-copy', { definitionsDir })
    assertEveryKey(localProjection('roundtrip-copy', 1, definitionsDir), 'clone')
  }))

test('an Artefact that sets document-control and satisfies-gate to true keeps loading with both keys omitted from the projection', () =>
  withScratch(({ definitionsDir }) => {
    writeLocalFixture(definitionsDir, 'roundtrip')
    const path = join(definitionsDir, 'roundtrip/1/definition.yaml')
    writeFileSync(path, readFileSync(path, 'utf8').replace('document-control: false', 'document-control: true').replace('satisfies-gate: false', 'satisfies-gate: true'))
    const letter = localProjection('roundtrip', 1, definitionsDir).artefacts.find((a) => a.id === 'letter')
    assert.equal('documentControl' in letter, false)
    assert.equal('satisfiesGate' in letter, false)
  }))

test('the packaged definitions project exactly as before: no new keys appear on design or recruitment-onboarding', () => {
  for (const [id, version] of [['design', 1], ['design', 2], ['recruitment-onboarding', 1], ['recruitment-onboarding', 2]]) {
    const projection = localProjection(id, version, 'definitions')
    for (const stage of projection.stages) {
      assert.deepEqual(Object.keys(stage).filter((k) => !['id', 'title', 'purpose', 'gate', 'modules', 'example'].includes(k)), [], `${id} v${version} stage ${stage.id}`)
    }
    for (const artefact of projection.artefacts) {
      assert.deepEqual(
        Object.keys(artefact).filter((k) => !['id', 'title', 'purpose', 'template', 'gate', 'requires', 'filename'].includes(k)),
        [],
        `${id} v${version} artefact ${artefact.id}`
      )
    }
  }
})

// ---------- Promote to a Library repo ----------

test('every key survives promotion to a Library repo', () =>
  withScratch(({ definitionsDir }) =>
    withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: { 'README.md': 'library\n' } }, async (baseUrl) => {
      writeLocalFixture(definitionsDir, 'roundtrip', { status: 'published' })
      const repo = { id: 'lib', provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl } }
      const files = readWorkspaceVersionFolderFiles(definitionsDir, 'roundtrip', 1)
      const result = await promoteDefinitionVersionToRepo({ definitionId: 'roundtrip', version: 1, files, repo, pat: GITHUB_VALID_PAT })
      assert.equal(result.ok, true)
      const promoted = await loadGitHubDefinition('roundtrip', 1, {
        github: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl, branch: promotionBranchName('roundtrip', 1) },
      })
      assertEveryKey(definitionVersionProjection(promoted), 'promote')
    })
  ))

// ---------- The four Provider Definition loaders and write paths, and the Library cache ----------

const PROVIDERS = [
  {
    name: 'Azure DevOps',
    withServer: (files, fn) => withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: ADO_REPOSITORY, validPat: ADO_VALID_PAT, files }, fn),
    options: (baseUrl) => ({ azureDevOps: { organization: ORGANIZATION, project: PROJECT, repository: ADO_REPOSITORY, pat: ADO_VALID_PAT, baseUrl } }),
    repo: (baseUrl) => ({ provider: 'azure-devops', location: { organization: ORGANIZATION, project: PROJECT, repository: ADO_REPOSITORY, baseUrl } }),
    pat: ADO_VALID_PAT,
    load: loadAzureDevOpsDefinition,
    write: writeAzureDevOpsDefinitionVersion,
    publish: publishAzureDevOpsDefinitionVersion,
    createDraft: createAzureDevOpsDraftVersion,
  },
  {
    name: 'GitHub',
    withServer: (files, fn) => withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files }, fn),
    options: (baseUrl) => ({ github: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl } }),
    repo: (baseUrl) => ({ provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl } }),
    pat: GITHUB_VALID_PAT,
    load: loadGitHubDefinition,
    write: writeGitHubDefinitionVersion,
    publish: publishGitHubDefinitionVersion,
    createDraft: createGitHubDraftVersion,
  },
  {
    name: 'GitLab',
    withServer: (files, fn) => withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files }, fn),
    options: (baseUrl) => ({ gitlab: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl } }),
    repo: (baseUrl) => ({ provider: 'gitlab', location: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, baseUrl } }),
    pat: GITLAB_VALID_PAT,
    load: loadGitLabDefinition,
    write: writeGitLabDefinitionVersion,
    publish: publishGitLabDefinitionVersion,
    createDraft: createGitLabDraftVersion,
  },
  {
    name: 'Atlassian',
    withServer: (files, fn) => withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files }, fn),
    options: (baseUrl) => ({ atlassian: { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl } }),
    repo: (baseUrl) => ({ provider: 'atlassian', location: { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, jiraSite: 'fake-site', jiraProjectKey: 'FAKE', baseUrl } }),
    pat: BITBUCKET_VALID_PAT,
    load: loadAtlassianDefinition,
    write: writeAtlassianDefinitionVersion,
    publish: publishAtlassianDefinitionVersion,
    createDraft: createAtlassianDraftVersion,
  },
]

for (const provider of PROVIDERS) {
  test(`${provider.name}: the Definition loader and the Library cache keep every key, and a clone from the cache keeps them too`, () =>
    withScratch(({ definitionsDir, instancesDir }) =>
      provider.withServer(repoFiles('roundtrip', { status: 'published' }), async (baseUrl) => {
        const loaded = await provider.load('roundtrip', 1, provider.options(baseUrl))
        assertEveryKey(definitionVersionProjection(loaded), `${provider.name} loader`)

        // Registered so a clone can find the mirror; refreshed with the fake server's own location, since
        // a registered Atlassian location is Cloud-only and never keeps a baseUrl override.
        const repo = addLibraryRepo(provider.repo(baseUrl), { instancesDir })
        await refreshLibraryRepo({ ...repo, location: provider.repo(baseUrl).location }, { instancesDir, pat: provider.pat })
        const cacheDir = libraryRepoDefinitionsDir(instancesDir, repo.id)
        assertEveryKey(localProjection('roundtrip', 1, cacheDir), `${provider.name} Library cache`)

        cloneFromLibraryRepoMirror('roundtrip', 'roundtrip-clone', definitionsDir, { instancesDir })
        assertEveryKey(localProjection('roundtrip-clone', 1, definitionsDir), `${provider.name} clone from the Library cache`)
      })
    ))

  test(`${provider.name}: every key survives a workspace save, publish and new draft version`, () =>
    provider.withServer(repoFiles('roundtrip'), async (baseUrl) => {
      const options = provider.options(baseUrl)
      const structure = definitionVersionProjection(await provider.load('roundtrip', 1, options))
      const saved = await provider.write('roundtrip', 1, structure, options)
      assert.equal(saved.problems, undefined, JSON.stringify(saved.problems))
      assertEveryKey(saved, `${provider.name} save`)

      const published = await provider.publish('roundtrip', 1, options)
      assert.equal(published.problems, undefined, JSON.stringify(published.problems))
      assertEveryKey(published, `${provider.name} publish`)

      const { version } = await provider.createDraft('roundtrip', options)
      assertEveryKey(definitionVersionProjection(await provider.load('roundtrip', version, options)), `${provider.name} new draft version`)
    }))
}

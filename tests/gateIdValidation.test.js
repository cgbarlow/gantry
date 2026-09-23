import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadDefinition,
  definitionVersionProjection,
  findDefinitionProblemsInStructure,
  writeDefinitionVersion,
  publishDefinitionVersion,
  listVersionNumbers,
} from '../lib/definition.js'
import { validateDefinition } from '../lib/validate.js'
import { validateLocalDefinition } from '../web/lib/localStatus.js'
import { loadAzureDevOpsDefinition, publishAzureDevOpsDefinitionVersion } from '../lib/definitionAzureDevOps.js'
import { loadGitHubDefinition, publishGitHubDefinitionVersion } from '../lib/definitionGitHub.js'
import { loadGitLabDefinition, publishGitLabDefinitionVersion } from '../lib/definitionGitLab.js'
import { loadAtlassianDefinition, publishAtlassianDefinitionVersion } from '../lib/definitionAtlassian.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'
import { withFakeGitLabServer, GITLAB_NAMESPACE, GITLAB_REPOSITORY, GITLAB_VALID_PAT } from './helpers/fakeGitLabServer.js'
import { withFakeBitbucketServer, BITBUCKET_OWNER, BITBUCKET_REPOSITORY, BITBUCKET_VALID_PAT } from './helpers/fakeBitbucketServer.js'

// #149 (spec #147, "Gate-id validation") — an Artefact's `gate` and a Field's `required-at` name Stage
// gates, and nothing used to check that they do: a typo silently disabled the requirement (an Artefact
// that never counts toward any Gate, a Field never required anywhere). These tests drive every place a
// Definition author meets validation — `gantry validate`, web-editor save, publish (local and each
// Provider), the Definitions page's live markers and the Local Workspace twin — and the one place the
// new problems must *not* reach: loading a Definition an existing instance already runs on.

// The fixture: a two-Stage Definition whose Artefact gate and `required-at` carry one typo each
// (`frist-gate`, `secnd-gate`) and whose other Field sets `required-at` to a bare string.
function definitionYaml({ status = 'draft', artefactGate = 'frist-gate' } = {}) {
  return `id: typos
version: 1
status: ${status}
title: Typos
description: Gate ids that name no Stage gate
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
artefacts:
  - id: brief
    title: Brief
    purpose: The brief
    template: templates/brief.md.tmpl
    gate: ${artefactGate}
    requires:
      - details
`
}

const DETAILS_MODULE_YAML = `id: details
title: Details
purpose: What the engagement is
fields:
  - id: summary
    title: Summary
    type: markdown
    required-at:
      - secnd-gate
  - id: notes
    title: Notes
    type: markdown
    required-at: second-gate
`

const CLEAN_DETAILS_MODULE_YAML = DETAILS_MODULE_YAML.replace('secnd-gate', 'second-gate').replace('required-at: second-gate', 'required-at: [second-gate]')

function writeLocalFixture(definitionsDir, options) {
  const dir = join(definitionsDir, 'typos', '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(join(dir, 'definition.yaml'), definitionYaml(options))
  writeFileSync(join(dir, 'modules', 'details.yaml'), DETAILS_MODULE_YAML)
  writeFileSync(join(dir, 'templates', 'brief.md.tmpl'), '# Brief\n')
}

function withScratch(fn) {
  const root = mkdtempSync(join(tmpdir(), 'defs-149-'))
  const definitionsDir = join(root, 'definitions')
  mkdirSync(definitionsDir)
  return Promise.resolve(fn({ definitionsDir })).finally(() => rmSync(root, { recursive: true, force: true }))
}

// The three problems the fixture carries, as an author would read them.
function assertGateProblems(problems, where) {
  const byType = (type) => problems.filter((p) => p.type === type)
  assert.equal(byType('unknown-artefact-gate').length, 1, `${where}: ${JSON.stringify(problems)}`)
  assert.match(byType('unknown-artefact-gate')[0].message, /^Artefact "brief" .*"frist-gate".*"first-gate", "second-gate"/, where)
  assert.equal(byType('unknown-required-at-gate').length, 1, `${where}: ${JSON.stringify(problems)}`)
  assert.match(byType('unknown-required-at-gate')[0].message, /^Module "details" field "summary" .*"secnd-gate"/, where)
  assert.equal(byType('invalid-required-at').length, 1, `${where}: ${JSON.stringify(problems)}`)
  assert.match(byType('invalid-required-at')[0].message, /^Module "details" field "notes" .*required-at/, where)
}

test('gantry validate reports an Artefact gate and a required-at gate that name no Stage gate, and a required-at that is not a list', () =>
  withScratch(({ definitionsDir }) => {
    writeLocalFixture(definitionsDir)
    const result = validateDefinition('typos', { definitionsDir, version: 1 })
    assert.equal(result.valid, false)
    assertGateProblems(result.problems, 'gantry validate')
  }))

test('an existing instance\'s Definition with these problems still loads', () =>
  withScratch(({ definitionsDir }) => {
    writeLocalFixture(definitionsDir, { status: 'published' })
    const definition = loadDefinition('typos', { definitionsDir, version: 1 })
    assert.equal(definition.artefacts[0].gate, 'frist-gate')
  }))

test('web-editor save is refused with the problems, and nothing is written', () =>
  withScratch(({ definitionsDir }) => {
    writeLocalFixture(definitionsDir, { artefactGate: 'first-gate' })
    writeFileSync(join(definitionsDir, 'typos/1/modules/details.yaml'), CLEAN_DETAILS_MODULE_YAML)
    const structure = definitionVersionProjection(loadDefinition('typos', { definitionsDir, version: 1 }))
    assert.deepEqual(validateDefinition('typos', { definitionsDir, version: 1 }).problems, [])

    structure.artefacts[0].gate = 'frist-gate'
    structure.modules[0].fields[0].requiredAt = ['secnd-gate']
    structure.modules[0].fields[1].requiredAt = 'second-gate'
    const saved = writeDefinitionVersion('typos', 1, structure, { definitionsDir })
    assertGateProblems(saved.problems ?? [], 'save')
    assert.equal(loadDefinition('typos', { definitionsDir, version: 1 }).artefacts[0].gate, 'first-gate', 'the refused save left the draft as it was')
  }))

test('a blank Artefact gate names no Stage gate either', () => {
  const problems = findDefinitionProblemsInStructure({
    stages: [{ id: 'first', gate: 'first-gate', modules: [] }],
    artefacts: [{ id: 'new-artefact-1', gate: '', requires: [] }],
    modules: [],
  })
  assert.deepEqual(problems.map((p) => p.type), ['unknown-artefact-gate'])
  assert.match(problems[0].message, /^Artefact "new-artefact-1" has no gate/)
})

test('publish is refused with the problems, and the draft stays a draft', () =>
  withScratch(({ definitionsDir }) => {
    writeLocalFixture(definitionsDir)
    const published = publishDefinitionVersion('typos', 1, { definitionsDir })
    assertGateProblems(published.problems ?? [], 'publish')
    assert.equal(loadDefinition('typos', { definitionsDir, version: 1 }).status, 'draft')
  }))

test('the Definitions page\'s live markers and the Local Workspace validate report the same problems', () =>
  withScratch(({ definitionsDir }) => {
    writeLocalFixture(definitionsDir)
    const structure = definitionVersionProjection(loadDefinition('typos', { definitionsDir, version: 1 }))
    assertGateProblems(findDefinitionProblemsInStructure(structure), 'live markers')
    assertGateProblems(validateLocalDefinition(structure).problems, 'Local Workspace validate')
  }))

test('every bundled Definition version reports zero problems', () => {
  for (const id of ['design', 'recruitment-onboarding']) {
    for (const version of listVersionNumbers(id, 'definitions')) {
      const result = validateDefinition(id, { version })
      assert.deepEqual(result.problems, [], `${id} v${version}`)
      const structure = definitionVersionProjection(loadDefinition(id, { version }))
      assert.deepEqual(findDefinitionProblemsInStructure(structure), [], `${id} v${version} (live markers)`)
      assert.deepEqual(validateLocalDefinition(structure).problems, [], `${id} v${version} (Local Workspace)`)
    }
  }
})

// Provider publish re-reads the draft from the repo and checks it with the in-memory rule set, so the
// Stage and Artefact gates must reach that check — otherwise every Artefact would look gateless and
// every Provider publish would fail. A clean draft publishing is covered for all four Providers by
// tests/definitionKeyRoundTrip.test.js; here the same path refuses the typo.
const PROVIDERS = [
  {
    name: 'Azure DevOps',
    withServer: (files, fn) => withFakeAzureDevOpsServer({ organization: 'fake-org', project: 'fake-project', repository: 'fake-ado-repo', validPat: 'valid-ado-test-pat', files }, fn),
    options: (baseUrl) => ({ azureDevOps: { organization: 'fake-org', project: 'fake-project', repository: 'fake-ado-repo', pat: 'valid-ado-test-pat', baseUrl } }),
    load: loadAzureDevOpsDefinition,
    publish: publishAzureDevOpsDefinitionVersion,
  },
  {
    name: 'GitHub',
    withServer: (files, fn) => withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files }, fn),
    options: (baseUrl) => ({ github: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl } }),
    load: loadGitHubDefinition,
    publish: publishGitHubDefinitionVersion,
  },
  {
    name: 'GitLab',
    withServer: (files, fn) => withFakeGitLabServer({ namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, validPat: GITLAB_VALID_PAT, files }, fn),
    options: (baseUrl) => ({ gitlab: { namespace: GITLAB_NAMESPACE, repository: GITLAB_REPOSITORY, pat: GITLAB_VALID_PAT, baseUrl } }),
    load: loadGitLabDefinition,
    publish: publishGitLabDefinitionVersion,
  },
  {
    name: 'Atlassian',
    withServer: (files, fn) => withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files }, fn),
    options: (baseUrl) => ({ atlassian: { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl } }),
    load: loadAtlassianDefinition,
    publish: publishAtlassianDefinitionVersion,
  },
]

for (const provider of PROVIDERS) {
  test(`${provider.name}: publish is refused with the problems, and the draft stays a draft`, () => {
    const files = {
      '/definitions/typos/1/definition.yaml': definitionYaml(),
      '/definitions/typos/1/modules/details.yaml': DETAILS_MODULE_YAML,
    }
    return provider.withServer(files, async (baseUrl) => {
      const options = provider.options(baseUrl)
      const published = await provider.publish('typos', 1, options)
      assertGateProblems(published.problems ?? [], `${provider.name} publish`)
      assert.equal((await provider.load('typos', 1, options)).status, 'draft')
    })
  })
}

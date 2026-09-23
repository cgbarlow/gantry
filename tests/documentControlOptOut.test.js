import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { program } from '../bin/gantry.js'
import { renderArtefact, renderStageArtefacts, prepareAzureDevOpsWasmRender } from '../lib/render.js'
import { loadDefinition, definitionVersionProjection, findDefinitionProblems, findDefinitionProblemsInStructure, writeDefinitionVersion } from '../lib/definition.js'
import { runLocalWorkspaceCompute } from '../lib/localWorkspace.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { loadAzureDevOpsDefinition, writeAzureDevOpsDefinitionVersion, publishAzureDevOpsDefinitionVersion } from '../lib/definitionAzureDevOps.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'

// #150 (spec #147, ADR-0049): `document-control: false` on an Artefact leaves both the Document
// Control table and the Review & sign-off table out of that Artefact's render, keeping its H1 —
// the per-Artefact form of the older per-Definition opt-out (an empty
// `templates/_documentControl.md.tmpl`). Every render path goes through the one compile step, so
// these tests drive a representative spread of them — local dry run, the CLI, a local workspace's
// inline Definition, a Provider's two-push render, stage approval's auto-render and the Azure
// DevOps WASM prepare — against a copy of recruitment-onboarding v2 whose Offer Pack opts out while the Appointment Case keeps
// both tables. The bundled Definition is never touched.

const CONTROL = ['## Document Control', '## Review & sign-off']
const SLUG = 'platform-engineer'
const EXAMPLE_DIR = `workspaces/examples/${SLUG}`

// A scratch definitions dir holding a copy of recruitment-onboarding with the Offer Pack opted out.
async function withOptedOutDefinitions(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'gantry-doc-control-defs-'))
  try {
    cpSync('definitions/recruitment-onboarding', join(definitionsDir, 'recruitment-onboarding'), { recursive: true })
    const yamlPath = join(definitionsDir, 'recruitment-onboarding', '2', 'definition.yaml')
    const yaml = readFileSync(yamlPath, 'utf8')
    const optedOut = yaml.replace(
      '    filename: "{selection.candidate-name} - Offer Pack - {contract.start-date}"\n',
      '    filename: "{selection.candidate-name} - Offer Pack - {contract.start-date}"\n    document-control: false\n'
    )
    assert.notEqual(optedOut, yaml, 'the fixture edit must land')
    writeFileSync(yamlPath, optedOut)
    return await fn(definitionsDir)
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
  }
}

async function withInstancesDir(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-doc-control-instances-'))
  try {
    cpSync(EXAMPLE_DIR, join(instancesDir, SLUG), { recursive: true })
    return await fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

function assertNoControlTables(markdown, title) {
  assert.match(markdown, new RegExp(`^# Platform Engineer: ${title}`), 'the H1 is kept')
  for (const heading of CONTROL) assert.ok(!markdown.includes(heading), `"${heading}" should be left out`)
}

function assertControlTables(markdown) {
  for (const heading of CONTROL) assert.ok(markdown.includes(heading), `"${heading}" should be present`)
}

function exampleWorkspaceFiles() {
  const files = { [`/gantry-workspace/${SLUG}/instance.yaml`]: readFileSync(join(EXAMPLE_DIR, 'instance.yaml'), 'utf8') }
  for (const name of readdirSync(join(EXAMPLE_DIR, 'modules'))) {
    files[`/gantry-workspace/${SLUG}/modules/${name}`] = readFileSync(join(EXAMPLE_DIR, 'modules', name), 'utf8')
  }
  return files
}

test('a local dry-run render leaves both tables out of the opted-out Artefact only', async () => {
  await withOptedOutDefinitions((definitionsDir) =>
    withInstancesDir((instancesDir) => {
      const offerPack = renderArtefact(SLUG, 'offer-pack', { dryRun: true, instancesDir, definitionsDir })
      assertNoControlTables(offerPack.markdown, 'Offer Pack')
      // The rest of the document is still there.
      assert.match(offerPack.markdown, /\n# /)

      const appointmentCase = renderArtefact(SLUG, 'appointment-case', { dryRun: true, instancesDir, definitionsDir })
      assertControlTables(appointmentCase.markdown)
    })
  )
})

test('without the key the same Artefact renders both tables, exactly as before', async () => {
  await withInstancesDir((instancesDir) => {
    const offerPack = renderArtefact(SLUG, 'offer-pack', { dryRun: true, instancesDir, definitionsDir: 'definitions' })
    assertControlTables(offerPack.markdown)
  })
})

test('an explicit document-control: true renders both tables, the same as leaving the key out', async () => {
  await withOptedOutDefinitions((definitionsDir) =>
    withInstancesDir((instancesDir) => {
      const yamlPath = join(definitionsDir, 'recruitment-onboarding', '2', 'definition.yaml')
      writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8').replace('document-control: false', 'document-control: true'))
      const offerPack = renderArtefact(SLUG, 'offer-pack', { dryRun: true, instancesDir, definitionsDir })
      assertControlTables(offerPack.markdown)
    })
  )
})

test('`gantry render --dry-run` leaves both tables out of the opted-out Artefact', async () => {
  program.exitOverride()
  await withOptedOutDefinitions((definitionsDir) =>
    withInstancesDir(async (instancesDir) => {
      const logs = []
      const origLog = console.log
      console.log = (...args) => logs.push(args.join(' '))
      try {
        await program.parseAsync(['node', 'gantry.js', 'render', SLUG, 'offer-pack', '--dry-run', '--instances-dir', instancesDir, '--definitions-dir', definitionsDir])
      } finally {
        console.log = origLog
      }
      assertNoControlTables(logs.join('\n'), 'Offer Pack')
    })
  )
})

test('a local workspace render against its own inline Definition leaves both tables out of the opted-out Artefact', async () => {
  const definitionDir = 'definitions/recruitment-onboarding/2'
  const structure = definitionVersionProjection(loadDefinition('recruitment-onboarding', { version: 2 }))
  structure.artefacts.find((a) => a.id === 'offer-pack').documentControl = false
  const templates = {}
  for (const name of readdirSync(join(definitionDir, 'templates'))) {
    if (name.endsWith('.md.tmpl')) templates[name] = readFileSync(join(definitionDir, 'templates', name), 'utf8')
  }
  const moduleFiles = {}
  for (const name of readdirSync(join(EXAMPLE_DIR, 'modules'))) {
    moduleFiles[name.replace(/\.md$/, '')] = readFileSync(join(EXAMPLE_DIR, 'modules', name), 'utf8')
  }
  const payload = {
    definitionId: 'recruitment-onboarding',
    definitionVersion: 2,
    instanceYaml: readFileSync(join(EXAMPLE_DIR, 'instance.yaml'), 'utf8'),
    moduleFiles,
    definition: { structure, templates },
  }

  const offerPack = await runLocalWorkspaceCompute('compile', { ...payload, artefact: 'offer-pack' })
  assertNoControlTables(offerPack.markdown, 'Offer Pack')
  const appointmentCase = await runLocalWorkspaceCompute('compile', { ...payload, artefact: 'appointment-case' })
  assertControlTables(appointmentCase.markdown)
})

const ADO = { organization: 'fake-org', project: 'fake-project', repository: 'fake-repo', validPat: 'valid-test-pat' }

test('an Azure DevOps render pushes the opted-out Artefact without either table on both pushes', async () => {
  await withOptedOutDefinitions((definitionsDir) =>
    withFakeAzureDevOpsServer({ ...ADO, files: exampleWorkspaceFiles() }, async (baseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-doc-control-scratch-'))
      try {
        const azureDevOps = { organization: ADO.organization, project: ADO.project, repository: ADO.repository, pat: ADO.validPat, baseUrl }
        const result = await renderArtefact(SLUG, 'offer-pack', { azureDevOps, definitionsDir, instancesDir, format: 'md' })
        assert.match(result.commit.hash, /^[0-9a-f]{7}$/, 'still the two-push render that learns its commit')
        const pushed = await createAzureDevOpsClient(azureDevOps).getFileContent(result.azureDevOpsPath)
        assertNoControlTables(Buffer.from(pushed, 'base64').toString('utf8'), 'Offer Pack')

        const kept = await renderArtefact(SLUG, 'appointment-case', { azureDevOps, definitionsDir, instancesDir, format: 'md' })
        assertControlTables(kept.markdown)
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    })
  )
})

// Stage approval's auto-render (lib/stageApproval.js) renders every missing gate Artefact through
// renderStageArtefacts; the opted-out one lands without either table next to one that keeps both.
test('the stage-approval auto-render pushes the opted-out Artefact without either table, beside one that keeps both', async () => {
  await withOptedOutDefinitions((definitionsDir) =>
    withFakeAzureDevOpsServer({ ...ADO, files: exampleWorkspaceFiles() }, async (baseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-doc-control-scratch-'))
      try {
        const azureDevOps = { organization: ADO.organization, project: ADO.project, repository: ADO.repository, pat: ADO.validPat, baseUrl }
        const definition = loadDefinition('recruitment-onboarding', { definitionsDir, version: 2 })
        const stage = definition.stages.find((s) => s.gate === 'onboarding-approved')
        const results = await renderStageArtefacts(SLUG, definition, stage, { azureDevOps, definitionsDir, instancesDir, format: 'md' })
        const client = createAzureDevOpsClient(azureDevOps)
        const pushed = async (artefactId) => {
          const result = results.find((r) => r.artefactId === artefactId)
          assert.equal(result?.rendered, true, `${artefactId} rendered`)
          return Buffer.from(await client.getFileContent(result.azureDevOpsPath), 'base64').toString('utf8')
        }
        assertNoControlTables(await pushed('offer-pack'), 'Offer Pack')
        assertControlTables(await pushed('appointment-case'))
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    })
  )
})

test('a GitHub render pushes the opted-out Artefact without either table', async () => {
  await withOptedOutDefinitions((definitionsDir) =>
    withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: exampleWorkspaceFiles() }, async (baseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-doc-control-scratch-'))
      try {
        const github = { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl }
        const result = await renderArtefact(SLUG, 'offer-pack', { github, definitionsDir, instancesDir, format: 'md' })
        assertNoControlTables(result.markdown, 'Offer Pack')
        assertNoControlTables(await createGitHubClient(github).getFileContent(result.githubPath), 'Offer Pack')
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    })
  )
})

test('the Azure DevOps WASM prepare hands the browser markdown without either table for the opted-out Artefact', async () => {
  await withOptedOutDefinitions((definitionsDir) =>
    withFakeAzureDevOpsServer({ ...ADO, files: exampleWorkspaceFiles() }, async (baseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-doc-control-scratch-'))
      try {
        const azureDevOps = { organization: ADO.organization, project: ADO.project, repository: ADO.repository, pat: ADO.validPat, baseUrl }
        const prepared = await prepareAzureDevOpsWasmRender(SLUG, 'offer-pack', { azureDevOps, definitionsDir, instancesDir })
        assert.match(prepared.commit.hash, /^[0-9a-f]{7}$/)
        assertNoControlTables(prepared.markdown, 'Offer Pack')

        const kept = await prepareAzureDevOpsWasmRender(SLUG, 'appointment-case', { azureDevOps, definitionsDir, instancesDir })
        assertControlTables(kept.markdown)
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    })
  )
})

// ── Validation ──────────────────────────────────────────────────────────────────────────────────

const NON_BOOLEAN = /^Artefact "offer-pack" sets "document-control" to "no" — it must be true or false$/

test('a non-boolean document-control is a validation problem on disk (gantry validate, load, publish)', async () => {
  await withOptedOutDefinitions((definitionsDir) => {
    const yamlPath = join(definitionsDir, 'recruitment-onboarding', '2', 'definition.yaml')
    writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8').replace('document-control: false', 'document-control: "no"'))
    const problems = findDefinitionProblems('recruitment-onboarding', { definitionsDir, version: 2 })
    assert.deepEqual(problems.map((p) => p.type), ['invalid-document-control'])
    assert.match(problems[0].message, NON_BOOLEAN)
  })
})

test('a false document-control on disk is not a problem', async () => {
  await withOptedOutDefinitions((definitionsDir) => {
    assert.deepEqual(findDefinitionProblems('recruitment-onboarding', { definitionsDir, version: 2 }), [])
  })
})

test('a non-boolean document-control is a validation problem in an in-memory structure (save, Provider publish) and a local workspace', () => {
  const structure = definitionVersionProjection(loadDefinition('recruitment-onboarding', { version: 2 }))
  structure.artefacts.find((a) => a.id === 'offer-pack').documentControl = 'no'
  for (const problems of [findDefinitionProblemsInStructure(structure), findLocalDefinitionProblems(structure)]) {
    assert.deepEqual(problems.map((p) => p.type), ['invalid-document-control'])
    assert.match(problems[0].message, NON_BOOLEAN)
  }
  structure.artefacts.find((a) => a.id === 'offer-pack').documentControl = true
  assert.deepEqual(findDefinitionProblemsInStructure(structure), [])
  assert.deepEqual(findLocalDefinitionProblems(structure), [])
})

test('saving a draft refuses a non-boolean document-control and keeps a false one', async () => {
  await withOptedOutDefinitions((definitionsDir) => {
    // The copied v2, flipped to a draft in the scratch dir so the save has something to write to
    // that doesn't depend on the evolving v3 draft.
    const yamlPath = join(definitionsDir, 'recruitment-onboarding', '2', 'definition.yaml')
    const yaml = readFileSync(yamlPath, 'utf8')
    const asDraft = yaml.replace(/^status: published$/m, 'status: draft')
    assert.notEqual(asDraft, yaml, 'the fixture edit must land')
    writeFileSync(yamlPath, asDraft)
    const structure = definitionVersionProjection(loadDefinition('recruitment-onboarding', { definitionsDir, version: 2 }))
    const offerPack = structure.artefacts.find((a) => a.id === 'offer-pack')

    offerPack.documentControl = 'no'
    const refused = writeDefinitionVersion('recruitment-onboarding', 2, structure, { definitionsDir })
    assert.deepEqual(refused.problems.map((p) => p.type), ['invalid-document-control'])

    offerPack.documentControl = false
    const saved = writeDefinitionVersion('recruitment-onboarding', 2, structure, { definitionsDir })
    assert.equal(saved.problems, undefined)
    const reloaded = loadDefinition('recruitment-onboarding', { definitionsDir, version: 2 })
    assert.equal(reloaded.artefacts.find((a) => a.id === 'offer-pack').documentControl, false)
    assert.equal(reloaded.artefacts.find((a) => a.id === 'appointment-case').documentControl, undefined)
  })
})

// A Provider's Definition loader doesn't validate on read, so a hand-edited `"no"` in a Provider
// draft has to survive the version projection the Definitions page edits. Otherwise the page shows
// no marker and Save rebuilds definition.yaml without the key, deleting it without a word.
test('a Provider draft\'s non-boolean document-control reaches the Definitions page projection, which Save and Publish then refuse', async () => {
  const definitionDir = 'definitions/recruitment-onboarding/2'
  const files = {}
  const yaml = readFileSync(join(definitionDir, 'definition.yaml'), 'utf8')
  const edited = yaml
    .replace(/^status: published$/m, 'status: draft')
    .replace(
      '    filename: "{selection.candidate-name} - Offer Pack - {contract.start-date}"\n',
      '    filename: "{selection.candidate-name} - Offer Pack - {contract.start-date}"\n    document-control: no\n'
    )
  assert.equal(edited.split('document-control: no').length, 2, 'the fixture edit must land')
  files['/definitions/recruitment-onboarding/2/definition.yaml'] = edited
  for (const name of readdirSync(join(definitionDir, 'modules'))) {
    files[`/definitions/recruitment-onboarding/2/modules/${name}`] = readFileSync(join(definitionDir, 'modules', name), 'utf8')
  }
  await withFakeAzureDevOpsServer({ ...ADO, files }, async (baseUrl) => {
    const options = { azureDevOps: { organization: ADO.organization, project: ADO.project, repository: ADO.repository, pat: ADO.validPat, baseUrl } }
    const projection = definitionVersionProjection(await loadAzureDevOpsDefinition('recruitment-onboarding', 2, options))
    assert.equal(projection.artefacts.find((a) => a.id === 'offer-pack').documentControl, 'no')
    const problems = findDefinitionProblemsInStructure(projection)
    assert.deepEqual(problems.map((p) => p.type), ['invalid-document-control'])
    assert.match(problems[0].message, NON_BOOLEAN)
    const saved = await writeAzureDevOpsDefinitionVersion('recruitment-onboarding', 2, projection, options)
    assert.deepEqual(saved.problems?.map((p) => p.type), ['invalid-document-control'])
    const published = await publishAzureDevOpsDefinitionVersion('recruitment-onboarding', 2, options)
    assert.deepEqual(published.problems?.map((p) => p.type), ['invalid-document-control'])
  })
})

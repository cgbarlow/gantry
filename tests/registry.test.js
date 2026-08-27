import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance, writeModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'
import { listRegistry } from '../lib/registry.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

function withScratchInstances(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('listRegistry lists every instance, sorted by slug, with definition, current stage, status and assignee', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'zebra-initiative', { instancesDir })
    createInstance('design', 'alpha-initiative', { instancesDir, assignee: 'c.barlow' })

    const registry = listRegistry({ instancesDir })
    assert.deepEqual(registry, [
      { slug: 'alpha-initiative', definition: 'design', stage: 'shape', status: 'incomplete', assignee: 'c.barlow' },
      { slug: 'zebra-initiative', definition: 'design', stage: 'shape', status: 'incomplete', assignee: '' },
    ])
  })
})

test('listRegistry reports "complete" once every required field for the current stage is filled in, independently of assignee', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir, assignee: 'c.barlow' })
    const definition = loadDefinition('design')

    for (const moduleId of ['context', 'solution-definition', 'team-and-estimates']) {
      const moduleSpec = definition.modules.get(moduleId)
      const fields = {}
      for (const field of moduleSpec.fields) {
        if (field.required) fields[field.id] = field.type === 'list' ? ['Filled in.'] : 'Filled in.'
      }
      writeModule(definition, 'my-initiative', moduleId, { status: 'agreed', owner: '', fields }, { instancesDir })
    }

    const registry = listRegistry({ instancesDir })
    const myInitiative = registry.find((i) => i.slug === 'my-initiative')
    assert.equal(myInitiative.status, 'complete')
    assert.equal(myInitiative.assignee, 'c.barlow')
  })
})

// The instance-level assignee (#97) is a plain field on the instance record, not derived by scanning any module's frontmatter `owner` — even though every module below has one set, it must not leak into this row.
test('listRegistry falls back to \'\' for assignee when the instance record has none set, regardless of module frontmatter owner', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const definition = loadDefinition('design')
    writeModule(
      definition,
      'my-initiative',
      'context',
      { status: 'draft', owner: 'c.barlow', fields: {} },
      { instancesDir }
    )

    const registry = listRegistry({ instancesDir })
    assert.equal(registry[0].assignee, '')
  })
})

test('listRegistry returns an empty array when instancesDir has no instances', () => {
  withScratchInstances((instancesDir) => {
    assert.deepEqual(listRegistry({ instancesDir }), [])
  })
})

test('listRegistry skips a stale registry entry (instance deleted from disk after being registered), without failing the whole listing', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'alpha-initiative', { instancesDir })
    createInstance('design', 'zebra-initiative', { instancesDir })
    // Backfills both slugs into the registry file.
    listRegistry({ instancesDir })

    // Simulates an instance directory removed after the registry already knows about it (manual cleanup, a rename, a future delete feature) — the registry itself has no way to notice this on its own.
    rmSync(join(instancesDir, 'alpha-initiative'), { recursive: true, force: true })

    const registry = listRegistry({ instancesDir })
    assert.deepEqual(
      registry.map((i) => i.slug),
      ['zebra-initiative']
    )
  })
})

test('listRegistry still throws on a genuine read failure, rather than silently skipping it the way a stale/missing entry is', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'broken-initiative', { instancesDir })
    // Unlike a *missing* instance.yaml (readInstance's "No instance ..." error, which listRegistry deliberately skips), a present-but-unparseable instance.yaml is a real problem that must still surface — it isn't the "instance was deleted after being registered" case the stale-entry skip above exists for.
    writeFileSync(join(instancesDir, 'broken-initiative', 'instance.yaml'), ': not: valid: yaml: [')

    assert.throws(() => listRegistry({ instancesDir }), /Nested mappings/)
  })
})

test('listRegistry reflects the real examples fixture in this repo', () => {
  const registry = listRegistry()
  const slugs = registry.map((i) => i.slug)
  assert.ok(slugs.includes('examples'))

  const examples = registry.find((i) => i.slug === 'examples')
  assert.equal(examples.definition, 'design')
  assert.equal(examples.stage, 'shape')
  assert.equal(examples.status, 'complete')
  assert.equal(examples.assignee, 'c.barlow')
})

// ---------- #102: the `workspace` field, for the Workspaces dashboard's grouping ----------

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'
const SEED_FILES = {
  '/gantry-workspace/remote-initiative/instance.yaml': 'definition: design\nstage: shape\nassignee: c.barlow\n',
  '/gantry-workspace/instance-one/instance.yaml': 'definition: design\nstage: shape\nassignee: c.barlow\n',
  '/gantry-workspace/instance-two/instance.yaml': 'definition: design\nstage: shape\nassignee: c.barlow\n',
}

test('listRegistry has no `workspace` field on a local row — Workspace is an Azure-DevOps-repo concept only', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const registry = listRegistry({ instancesDir })
    assert.equal('workspace' in registry[0], false)
  })
})

test('listRegistry carries a `workspace` field on an Azure-DevOps-backed row, matching the workspace its location was registered against', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withFakeAzureDevOpsServer(
      { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: SEED_FILES },
      async (adoBaseUrl) => {
        registerInstance(
          'remote-initiative',
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )

        const registry = await listRegistry({ instancesDir, pat: VALID_PAT })
        const row = registry.find((i) => i.slug === 'remote-initiative')
        assert.equal(row.workspace.organization, ORGANIZATION)
        assert.equal(row.workspace.project, PROJECT)
        assert.equal(row.workspace.repository, REPOSITORY)
        assert.equal(typeof row.workspace.id, 'string')
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('listRegistry gives two instances registered against the same Azure DevOps location the same `workspace.id` — the dashboard\'s own grouping key', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    await withFakeAzureDevOpsServer(
      { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: SEED_FILES },
      async (adoBaseUrl) => {
        const location = { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }
        registerInstance('instance-one', location, { instancesDir })
        registerInstance('instance-two', location, { instancesDir })

        const registry = await listRegistry({ instancesDir, pat: VALID_PAT })
        const one = registry.find((i) => i.slug === 'instance-one')
        const two = registry.find((i) => i.slug === 'instance-two')
        assert.equal(one.workspace.id, two.workspace.id)
      }
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

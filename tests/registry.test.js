import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInstance, writeModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'
import { listRegistry } from '../lib/registry.js'

function withScratchInstances(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('listRegistry lists every instance, sorted by slug, with definition, current stage, status and owner', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'zebra-initiative', { instancesDir })
    createInstance('design', 'alpha-initiative', { instancesDir, owner: 'c.barlow' })

    const registry = listRegistry({ instancesDir })
    assert.deepEqual(registry, [
      { slug: 'alpha-initiative', definition: 'design', stage: 'shape', status: 'incomplete', owner: 'c.barlow' },
      { slug: 'zebra-initiative', definition: 'design', stage: 'shape', status: 'incomplete', owner: '' },
    ])
  })
})

test('listRegistry reports "complete" once every required field for the current stage is filled in', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const definition = loadDefinition('design')

    for (const moduleId of ['context', 'solution-definition', 'team-and-estimates']) {
      const moduleSpec = definition.modules.get(moduleId)
      const fields = {}
      for (const field of moduleSpec.fields) {
        if (field.required) fields[field.id] = field.type === 'list' ? ['Filled in.'] : 'Filled in.'
      }
      writeModule(definition, 'my-initiative', moduleId, { status: 'agreed', owner: 'c.barlow', fields }, { instancesDir })
    }

    const registry = listRegistry({ instancesDir })
    const myInitiative = registry.find((i) => i.slug === 'my-initiative')
    assert.equal(myInitiative.status, 'complete')
    assert.equal(myInitiative.owner, 'c.barlow')
  })
})

test('listRegistry falls back to \'\' for owner when no current-stage module has one set', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })

    const registry = listRegistry({ instancesDir })
    assert.equal(registry[0].owner, '')
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

    // Simulates an instance directory removed after the registry already
    // knows about it (manual cleanup, a rename, a future delete feature) —
    // the registry itself has no way to notice this on its own.
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
    // Unlike a *missing* instance.yaml (readInstance's "No instance ..."
    // error, which listRegistry deliberately skips), a present-but-
    // unparseable instance.yaml is a real problem that must still surface
    // — it isn't the "instance was deleted after being registered" case
    // the stale-entry skip above exists for.
    writeFileSync(join(instancesDir, 'broken-initiative', 'instance.yaml'), ': not: valid: yaml: [')

    assert.throws(() => listRegistry({ instancesDir }), /Nested mappings/)
  })
})

test('listRegistry reflects the real examples/demo-cli/demo-web fixtures in this repo', () => {
  const registry = listRegistry()
  const slugs = registry.map((i) => i.slug)
  assert.ok(slugs.includes('examples'))
  assert.ok(slugs.includes('demo-cli'))
  assert.ok(slugs.includes('demo-web'))

  const examples = registry.find((i) => i.slug === 'examples')
  assert.equal(examples.definition, 'design')
  assert.equal(examples.stage, 'shape')
  assert.equal(examples.status, 'complete')
  assert.equal(examples.owner, 'c.barlow')
})

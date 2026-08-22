import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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

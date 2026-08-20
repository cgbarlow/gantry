import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDefinition } from '../lib/definition.js'
import { createInstance, readInstance, readModule, writeModule, parseModuleFile, listInstances } from '../lib/instance.js'

function withScratchInstances(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    fn(instancesDir)
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

test('creates a design instance with blank Shape-stage module files', () => {
  withScratchInstances((instancesDir) => {
    const result = createInstance('design', 'my-initiative', { instancesDir, owner: 'c.barlow' })
    assert.equal(result.stage, 'shape')
    assert.deepEqual(result.modules, ['context', 'solution-definition', 'team-and-estimates'])

    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance.definition, 'design')
    assert.equal(instance.stage, 'shape')

    const contextPath = join(instancesDir, 'my-initiative', 'modules', 'context.md')
    const raw = readFileSync(contextPath, 'utf8')
    assert.match(raw, /^---\n/)
    assert.match(raw, /owner: c\.barlow/)
    assert.match(raw, /## Business driver/)
    assert.match(raw, /## Affected domains/)
    assert.match(raw, /## Explicitly out of scope/)
  })
})

test('listInstances lists every instance, sorted by slug, with definition and stage', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'zebra-initiative', { instancesDir })
    createInstance('design', 'alpha-initiative', { instancesDir })

    const instances = listInstances({ instancesDir })
    assert.deepEqual(instances, [
      { slug: 'alpha-initiative', definition: 'design', stage: 'shape' },
      { slug: 'zebra-initiative', definition: 'design', stage: 'shape' },
    ])
  })
})

test('listInstances returns an empty array when instancesDir has no instances', () => {
  withScratchInstances((instancesDir) => {
    assert.deepEqual(listInstances({ instancesDir }), [])
  })
})

test('readInstance\'s error for an unknown slug lists the available instances', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    assert.throws(
      () => readInstance('not-a-real-slug', { instancesDir }),
      /Available instances: my-initiative/
    )
  })
})

test('reads a hand-filled module file back into field-keyed data', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const definition = loadDefinition('design')

    const contextPath = join(instancesDir, 'my-initiative', 'modules', 'context.md')
    writeFileSync(
      contextPath,
      [
        '---',
        'module: context',
        'status: review',
        'owner: c.barlow',
        '---',
        '',
        '## Business driver',
        '',
        'A new law requires this by June.',
        '',
        '## Affected domains',
        '',
        '- Payments',
        '- Client Record',
        '',
        '## Explicitly out of scope',
        '',
        'Nothing yet.',
        '',
      ].join('\n')
    )

    const data = readModule(definition, 'my-initiative', 'context', { instancesDir })
    assert.equal(data.status, 'review')
    assert.equal(data.owner, 'c.barlow')
    assert.equal(data.fields.driver, 'A new law requires this by June.')
    assert.deepEqual(data.fields['affected-domains'], ['Payments', 'Client Record'])
    assert.equal(data.fields['out-of-scope'], 'Nothing yet.')
  })
})

test('writeModule is the exact inverse of readModule', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const definition = loadDefinition('design')

    writeModule(
      definition,
      'my-initiative',
      'context',
      {
        status: 'review',
        owner: 'c.barlow',
        fields: {
          driver: 'A new law requires this by June.',
          'affected-domains': ['Payments', 'Client Record'],
          'out-of-scope': '',
        },
      },
      { instancesDir }
    )

    const data = readModule(definition, 'my-initiative', 'context', { instancesDir })
    assert.equal(data.status, 'review')
    assert.equal(data.owner, 'c.barlow')
    assert.equal(data.fields.driver, 'A new law requires this by June.')
    assert.deepEqual(data.fields['affected-domains'], ['Payments', 'Client Record'])
    assert.equal(data.fields['out-of-scope'], '')
  })
})

test('folds a wrapped list-item continuation line onto the item it follows, instead of dropping it', () => {
  const definition = loadDefinition('design')
  const moduleSpec = definition.modules.get('context')
  const data = parseModuleFile(
    [
      '---',
      'module: context',
      'status: draft',
      'owner:',
      '---',
      '',
      '## Affected domains',
      '',
      '- Payments (SWIFTT), including the reconciliation batch job that runs',
      '  nightly against the ledger',
      '- Client Record',
      '',
    ].join('\n'),
    moduleSpec
  )
  assert.deepEqual(data.fields['affected-domains'], [
    'Payments (SWIFTT), including the reconciliation batch job that runs nightly against the ledger',
    'Client Record',
  ])
})

test('leaves a field out of the result when its heading is missing', () => {
  const definition = loadDefinition('design')
  const moduleSpec = definition.modules.get('context')
  const data = parseModuleFile(
    '---\nmodule: context\nstatus: draft\nowner:\n---\n\n## Business driver\n\nSome text.\n',
    moduleSpec
  )
  assert.equal(data.fields.driver, 'Some text.')
  assert.ok(!('affected-domains' in data.fields))
})

test('matches a markdown-formatted heading against its field\'s plain-text title', () => {
  const definition = loadDefinition('design')
  const moduleSpec = definition.modules.get('context')
  const data = parseModuleFile(
    '---\nmodule: context\nstatus: draft\nowner:\n---\n\n## **Business driver**\n\nSome text.\n',
    moduleSpec
  )
  assert.equal(data.fields.driver, 'Some text.')
  assert.deepEqual(data.warnings, [])
})

test('warns (non-strict) on a heading that matches no field, leaving the parsed result unaffected', () => {
  const definition = loadDefinition('design')
  const moduleSpec = definition.modules.get('context')
  const data = parseModuleFile(
    '---\nmodule: context\nstatus: draft\nowner:\n---\n\n## Business driver\n\nSome text.\n\n## Not A Real Field\n\nWhatever.\n',
    moduleSpec
  )
  assert.equal(data.fields.driver, 'Some text.')
  assert.equal(data.warnings.length, 1)
  assert.match(data.warnings[0], /does not match any field/)
})

test('warns (non-strict) on a duplicate heading, identifying which occurrence wins', () => {
  const definition = loadDefinition('design')
  const moduleSpec = definition.modules.get('context')
  const data = parseModuleFile(
    '---\nmodule: context\nstatus: draft\nowner:\n---\n\n## Business driver\n\nFirst.\n\n## Business driver\n\nSecond.\n',
    moduleSpec
  )
  assert.equal(data.fields.driver, 'Second.')
  assert.equal(data.warnings.length, 1)
  assert.match(data.warnings[0], /duplicate heading/)
})

test('strict mode throws instead of warning on a non-matching heading', () => {
  const definition = loadDefinition('design')
  const moduleSpec = definition.modules.get('context')
  assert.throws(
    () =>
      parseModuleFile(
        '---\nmodule: context\nstatus: draft\nowner:\n---\n\n## Not A Real Field\n\nWhatever.\n',
        moduleSpec,
        { strict: true }
      ),
    /does not match any field/
  )
})

test('strict mode throws instead of warning on a duplicate heading', () => {
  const definition = loadDefinition('design')
  const moduleSpec = definition.modules.get('context')
  assert.throws(
    () =>
      parseModuleFile(
        '---\nmodule: context\nstatus: draft\nowner:\n---\n\n## Business driver\n\nFirst.\n\n## Business driver\n\nSecond.\n',
        moduleSpec,
        { strict: true }
      ),
    /duplicate heading/
  )
})

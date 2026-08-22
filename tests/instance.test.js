import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDefinition } from '../lib/definition.js'
import { createInstance, readInstance, readModule, writeModule, parseModuleFile, listInstances } from '../lib/instance.js'
import { AzureDevOpsAuthenticationError } from '../lib/azureDevOpsClient.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'

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

test('listInstances lists every instance, sorted by slug, with definition, stage, and which stages have data', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'zebra-initiative', { instancesDir })
    createInstance('design', 'alpha-initiative', { instancesDir })

    const instances = listInstances({ instancesDir })
    assert.deepEqual(instances, [
      { slug: 'alpha-initiative', definition: 'design', stage: 'shape', stagesWithData: ['shape'] },
      { slug: 'zebra-initiative', definition: 'design', stage: 'shape', stagesWithData: ['shape'] },
    ])
  })
})

test('listInstances reports every stage with data, not just the instance\'s current stage', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    writeFileSync(
      join(instancesDir, 'my-initiative', 'modules', 'hld-submission.md'),
      '---\nmodule: hld-submission\nstatus: draft\nowner:\n---\n'
    )

    const instances = listInstances({ instancesDir })
    const myInitiative = instances.find((i) => i.slug === 'my-initiative')
    assert.deepEqual(myInitiative.stagesWithData, ['shape', 'hld-define'])
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

// --- Azure DevOps-backed instances (#85) ---------------------------------
//
// These exercise createInstance/readInstance/readModule/writeModule's
// second storage backend — the Azure DevOps REST API (#84), via the same
// fake in-process server tests/azureDevOpsClient.test.js uses — instead of
// the local filesystem, reusing the exact same parseModuleFile/
// renderModuleFile logic the tests above exercise against disk. Every call
// here supplies `options.azureDevOps`; every call above doesn't, which is
// itself part of what proves the two paths are properly independent.

function azureDevOpsOptions(baseUrl, overrides = {}) {
  return {
    organization: ORGANIZATION,
    project: PROJECT,
    repository: REPOSITORY,
    pat: VALID_PAT,
    baseUrl,
    ...overrides,
  }
}

function withFakeRepo(files, fn) {
  return withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files }, fn)
}

test('createInstance writes instance.yaml and blank module files to Azure DevOps when a location is supplied, recording that location in instance.yaml', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    const result = await createInstance('design', 'my-initiative', { azureDevOps, owner: 'c.barlow' })
    assert.equal(result.stage, 'shape')
    assert.deepEqual(result.modules, ['context', 'solution-definition', 'team-and-estimates'])

    const instance = await readInstance('my-initiative', { azureDevOps })
    assert.equal(instance.definition, 'design')
    assert.equal(instance.stage, 'shape')
    assert.deepEqual(instance.azureDevOps, { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY })

    const definition = loadDefinition('design')
    const data = await readModule(definition, 'my-initiative', 'context', { azureDevOps })
    assert.equal(data.owner, 'c.barlow')
    assert.equal(data.status, 'draft')
  })
})

test('writeModule/readModule against Azure DevOps are the exact inverse of each other, same as the local-filesystem path', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    await createInstance('design', 'my-initiative', { azureDevOps })
    const definition = loadDefinition('design')

    await writeModule(
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
      { azureDevOps }
    )

    const data = await readModule(definition, 'my-initiative', 'context', { azureDevOps })
    assert.equal(data.status, 'review')
    assert.equal(data.owner, 'c.barlow')
    assert.equal(data.fields.driver, 'A new law requires this by June.')
    assert.deepEqual(data.fields['affected-domains'], ['Payments', 'Client Record'])
    assert.equal(data.fields['out-of-scope'], '')
  })
})

test('createInstance against Azure DevOps refuses to overwrite an instance that already exists there', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    await createInstance('design', 'my-initiative', { azureDevOps })
    await assert.rejects(() => createInstance('design', 'my-initiative', { azureDevOps }), /already exists/)
  })
})

test('createInstance against Azure DevOps reports exactly what was written and what remains if it fails partway through, instead of a bare network error', async () => {
  // instance.yaml is the 1st push; each first-stage module ("context",
  // "solution-definition", "team-and-estimates" for "design") is one push
  // each after that. failAfterPushes: 2 lets instance.yaml + "context"
  // through, then fails the very next push ("solution-definition") with a
  // simulated outage — independent of exactly how many GETs the client
  // makes per push, so this isn't coupled to that implementation detail.
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: {}, failAfterPushes: 2 },
    async (baseUrl) => {
      const azureDevOps = azureDevOpsOptions(baseUrl)
      await assert.rejects(
        () => createInstance('design', 'my-initiative', { azureDevOps }),
        /partially created.*module\(s\) context were written, but module "solution-definition" failed.*writeModule directly for the remaining module\(s\) \(solution-definition, team-and-estimates\)/s
      )
    }
  )
})

test('readInstance against Azure DevOps reports a missing instance distinctly, without the local path\'s "available instances" hint', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    await assert.rejects(
      () => readInstance('not-a-real-slug', { azureDevOps }),
      /No instance "not-a-real-slug" at Azure DevOps fake-org\/fake-project\/fake-repo/
    )
  })
})

test('readModule against Azure DevOps reports a missing module the same way the local path does', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    await createInstance('design', 'my-initiative', { azureDevOps })
    const definition = loadDefinition('design')
    // "hld-submission" belongs to a later stage than "shape" — createInstance
    // above only wrote the Shape-stage modules, so this one genuinely has no
    // saved data yet, on Azure DevOps exactly as it wouldn't on disk.
    await assert.rejects(
      () => readModule(definition, 'my-initiative', 'hld-submission', { azureDevOps }),
      /has no saved data for instance "my-initiative"/
    )
  })
})

test('a PAT the (fake) Azure DevOps server rejects surfaces from readInstance/readModule/writeModule/createInstance as AzureDevOpsAuthenticationError', async () => {
  await withFakeRepo({ '/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n' }, async (baseUrl) => {
    const badAzureDevOps = azureDevOpsOptions(baseUrl, { pat: 'a-pat-the-server-does-not-recognize' })
    const definition = loadDefinition('design')

    await assert.rejects(() => readInstance('my-initiative', { azureDevOps: badAzureDevOps }), AzureDevOpsAuthenticationError)
    await assert.rejects(
      () => readModule(definition, 'my-initiative', 'context', { azureDevOps: badAzureDevOps }),
      AzureDevOpsAuthenticationError
    )
    await assert.rejects(
      () => writeModule(definition, 'my-initiative', 'context', { fields: {} }, { azureDevOps: badAzureDevOps }),
      AzureDevOpsAuthenticationError
    )
    await assert.rejects(
      () => createInstance('design', 'another-initiative', { azureDevOps: badAzureDevOps }),
      AzureDevOpsAuthenticationError
    )
  })
})

test('createInstance/readInstance/readModule/writeModule stay fully synchronous (not Promises) with no Azure DevOps location given — the three local instances make zero Azure DevOps calls and are provably unaffected by this path existing', () => {
  withScratchInstances((instancesDir) => {
    const created = createInstance('design', 'my-initiative', { instancesDir })
    assert.equal(created instanceof Promise, false)

    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance instanceof Promise, false)

    const definition = loadDefinition('design')
    const data = readModule(definition, 'my-initiative', 'context', { instancesDir })
    assert.equal(data instanceof Promise, false)

    const written = writeModule(
      definition,
      'my-initiative',
      'context',
      { status: 'draft', owner: '', fields: {} },
      { instancesDir }
    )
    assert.equal(written instanceof Promise, false)
  })
})

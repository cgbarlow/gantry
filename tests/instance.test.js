import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDefinition } from '../lib/definition.js'
import {
  createInstance,
  readInstance,
  readModule,
  writeModule,
  parseModuleFile,
  listInstances,
  updateInstanceAssignee,
  migrateModuleHeadingScale,
  recordInstanceReviewRequest,
  recordInstanceReviewStatus,
} from '../lib/instance.js'
import { AzureDevOpsAuthenticationError, AzureDevOpsNotFoundError, createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
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
    assert.deepEqual(result.modules, ['context', 'solution-definition', 'team-and-estimates', 'dependencies', 'soap-full-details'])

    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance.definition, 'design')
    assert.equal(instance.stage, 'shape')

    const contextPath = join(instancesDir, 'my-initiative', 'modules', 'context.md')
    const raw = readFileSync(contextPath, 'utf8')
    assert.match(raw, /^---\n/)
    assert.match(raw, /owner: c\.barlow/)
    // New document heading scale (ADR-0016): module title at `#`, field headings at `##`.
    assert.match(raw, /^# Context$/m)
    assert.match(raw, /^## Business driver$/m)
    assert.match(raw, /^## Affected domains$/m)
    assert.match(raw, /^## Explicitly out of scope$/m)
  })
})

// --- Instance-level assignee (#97) ----------------------------------------
//
// An explicit, stored field on the instance record itself — replacing the old "derive an owner by scanning the current stage's module frontmatter" behaviour (now lib/registry.js/lib/repoCheck.js). Distinct from `options.owner` above, which still only seeds each first-stage module file's own frontmatter `owner` — the separate, untouched Design Authority sign-off convention.

test('createInstance defaults the instance record\'s assignee to empty', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance.assignee, '')
  })
})

test('createInstance records an explicitly given assignee on the instance record, independently of options.owner\'s module-frontmatter seeding', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir, assignee: 'c.barlow', owner: 'a-different-module-owner' })
    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance.assignee, 'c.barlow')

    const contextPath = join(instancesDir, 'my-initiative', 'modules', 'context.md')
    assert.match(readFileSync(contextPath, 'utf8'), /owner: a-different-module-owner/)
  })
})

test('a hand-written instance.yaml that predates #97 (no assignee field at all) reads back with assignee defaulting to \'\', not undefined', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    writeFileSync(
      join(instancesDir, 'my-initiative', 'instance.yaml'),
      'definition: design\nslug: my-initiative\nstage: shape\n'
    )
    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance.assignee, '')
  })
})

// Regression test: `assignee`'s '' default must not paper over a genuinely blank/malformed instance.yaml. `yaml.parse('')` returns `null` (not an object), and naively spreading it (`{ assignee: '', ...null }`) would silently turn that `null` into `{ assignee: '' }` — masking a read that should fail immediately (the same way it always has) behind a later, less clear error wherever the caller next uses the "successfully" read instance (e.g. `loadDefinition` rejecting an `undefined` id).
test('readInstance returns null (not a default-filled object) for a blank instance.yaml, the same as before #97', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    writeFileSync(join(instancesDir, 'my-initiative', 'instance.yaml'), '')
    assert.equal(readInstance('my-initiative', { instancesDir }), null)
  })
})

test('updateInstanceAssignee sets the stored assignee and preserves every other instance.yaml field', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const updated = updateInstanceAssignee('my-initiative', 'c.barlow', { instancesDir })
    assert.equal(updated.assignee, 'c.barlow')
    assert.equal(updated.definition, 'design')
    assert.equal(updated.stage, 'shape')

    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance.assignee, 'c.barlow')
    assert.equal(instance.stage, 'shape')
  })
})

test('updateInstanceAssignee can clear a previously set assignee back to \'\'', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir, assignee: 'c.barlow' })
    updateInstanceAssignee('my-initiative', '', { instancesDir })
    assert.equal(readInstance('my-initiative', { instancesDir }).assignee, '')
  })
})

test('assignee stays stable across a stage change — updating stage does not touch or clear it', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir, assignee: 'c.barlow' })
    // No real "advance a stage" API exists yet (#97's own investigation found none) — this simulates a stage transition the way one would actually land today, a direct instance.yaml edit, to prove assignee isn't wiped out or recomputed as a side effect of it.
    writeFileSync(
      join(instancesDir, 'my-initiative', 'instance.yaml'),
      'definition: design\nslug: my-initiative\nstage: hld-define\nassignee: c.barlow\n'
    )
    const instance = readInstance('my-initiative', { instancesDir })
    assert.equal(instance.stage, 'hld-define')
    assert.equal(instance.assignee, 'c.barlow')
  })
})

test('updateInstanceAssignee against Azure DevOps updates instance.yaml there, preserving its azureDevOps location field', async () => {
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT },
    async (baseUrl) => {
      const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
      await createInstance('design', 'my-initiative', { azureDevOps })

      const updated = await updateInstanceAssignee('my-initiative', 'c.barlow', { azureDevOps })
      assert.equal(updated.assignee, 'c.barlow')
      assert.deepEqual(updated.azureDevOps, { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY })

      const instance = await readInstance('my-initiative', { azureDevOps })
      assert.equal(instance.assignee, 'c.barlow')
    }
  )
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

// The editor's save payload (#132): `layout` carries the document sequence —
// including a custom Section inserted between two defined fields — and
// writeModule must replay it exactly, so the section stays below its
// neighbour across save/reload instead of sinking to the end of the file.
test('writeModule replays a supplied layout exactly, preserving a custom Section interleaved between defined fields', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const definition = loadDefinition('design')

    writeModule(
      definition,
      'my-initiative',
      'context',
      {
        status: 'draft',
        owner: '',
        fields: {
          driver: 'A new law requires this by June.',
          'affected-domains': ['Payments'],
          'out-of-scope': 'Nothing yet.',
        },
        layout: [
          { field: 'driver' },
          { custom: { id: 'custom:risks-we-carry', title: 'Risks we carry', value: 'The June deadline.' } },
          { field: 'affected-domains' },
          { field: 'out-of-scope' },
        ],
      },
      { instancesDir }
    )

    // On disk: the custom block sits between Business driver and Affected domains, exactly where it was inserted.
    const stored = readFileSync(join(instancesDir, 'my-initiative', 'modules', 'context.md'), 'utf8')
    assert.ok(stored.indexOf('## Risks we carry') > stored.indexOf('## Business driver'))
    assert.ok(stored.indexOf('## Risks we carry') < stored.indexOf('## Affected domains'))

    // And reading it back yields the same interleaved layout — the round-trip is stable.
    const data = readModule(definition, 'my-initiative', 'context', { instancesDir })
    assert.deepEqual(data.customFields, [
      { id: 'custom:risks-we-carry', title: 'Risks we carry', value: 'The June deadline.' },
    ])
    assert.deepEqual(data.layout, [
      { field: 'driver' },
      { custom: { id: 'custom:risks-we-carry', title: 'Risks we carry', value: 'The June deadline.' } },
      { field: 'affected-domains' },
      { field: 'out-of-scope' },
      { field: 'opportunity' },
      { field: 'in-scope' },
    ])
  })
})

// Every caller that predates #132 supplies no layout; their output must stay byte-for-byte what it always was.
test('writeModule without a layout still emits defined-field sections in definition order only', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const definition = loadDefinition('design')

    writeModule(
      definition,
      'my-initiative',
      'context',
      { status: 'review', owner: '', fields: { driver: 'Because.', 'affected-domains': [], 'out-of-scope': '' } },
      { instancesDir }
    )

    const stored = readFileSync(join(instancesDir, 'my-initiative', 'modules', 'context.md'), 'utf8')
    assert.deepEqual(
      [...stored.matchAll(/^## (.+)$/gm)].map((m) => m[1]),
      ['Business driver', 'Affected domains', 'Opportunity', 'In scope', 'Explicitly out of scope']
    )
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

// A `##` heading matching no defined field is no longer an anomaly (#132): Insert ▾ → Section makes such blocks first-class custom fields, preserved verbatim in `customFields` and positioned by `layout`, so warning (let alone throwing) would fail every instance that ever used the feature.
test('preserves a heading that matches no field as a custom field instead of warning', () => {
  const definition = loadDefinition('design')
  const moduleSpec = definition.modules.get('context')
  const data = parseModuleFile(
    '---\nmodule: context\nstatus: draft\nowner:\n---\n\n## Business driver\n\nSome text.\n\n## Risks we carry\n\nThe June deadline.\n',
    moduleSpec
  )
  assert.equal(data.fields.driver, 'Some text.')
  assert.deepEqual(data.warnings, [])
  assert.deepEqual(data.customFields, [{ id: 'custom:risks-we-carry', title: 'Risks we carry', value: 'The June deadline.' }])
  assert.deepEqual(data.layout, [
    { field: 'driver' },
    { custom: { id: 'custom:risks-we-carry', title: 'Risks we carry', value: 'The June deadline.' } },
  ])
})

// Untitled sections are exactly what Insert ▾ → Section inserts when the author skips the optional title prompt (#132): the heading is still preserved as structure, with a deterministic fallback id rather than an empty-slug one.
test('preserves an untitled custom section with a fallback id', () => {
  const definition = loadDefinition('design')
  const moduleSpec = definition.modules.get('context')
  const data = parseModuleFile(
    '---\nmodule: context\nstatus: draft\nowner:\n---\n\n## \n\nBody of an untitled block.\n',
    moduleSpec
  )
  assert.deepEqual(data.customFields, [
    { id: 'custom:section', title: '', value: 'Body of an untitled block.' },
  ])
})

// Same-slug headings must not collide into one custom field — the second gets a numeric suffix, deterministically, so round-trips stay stable.
test('suffixes colliding custom-field ids instead of merging the sections', () => {
  const definition = loadDefinition('design')
  const moduleSpec = definition.modules.get('context')
  const data = parseModuleFile(
    '---\nmodule: context\nstatus: draft\nowner:\n---\n\n## Risks\n\nOne.\n\n## Risks\n\nTwo.\n\n## Risks\n\nThree.\n',
    moduleSpec
  )
  assert.deepEqual(
    data.customFields.map((f) => f.id),
    ['custom:risks', 'custom:risks-2', 'custom:risks-3']
  )
  assert.equal(data.customFields[2].value, 'Three.')
  assert.deepEqual(data.warnings, [])
})

// The layout is the full document sequence — defined and custom entries interleaved exactly as written — which is what lets writeModule replay a Section inserted between two defined fields (#132).
test('layout records the interleaved order of defined and custom sections', () => {
  const definition = loadDefinition('design')
  const moduleSpec = definition.modules.get('context')
  const data = parseModuleFile(
    '---\nmodule: context\nstatus: draft\nowner:\n---\n\n## Business driver\n\nText.\n\n## Extra notes\n\nNotes.\n\n## Affected domains\n\n- Payments\n',
    moduleSpec
  )
  assert.deepEqual(data.layout, [
    { field: 'driver' },
    { custom: { id: 'custom:extra-notes', title: 'Extra notes', value: 'Notes.' } },
    { field: 'affected-domains' },
  ])
})

// A custom section whose body is entirely bullet items is a list-typed field (#144): the parser classifies it as type: 'list' with a string[] value, and the layout entry carries that type so the writer can replay it as bullets.
test('parses an all-bullets custom section as a list-typed custom field', () => {
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
      '## Business driver',
      '',
      'Some text.',
      '',
      '## Stakeholders',
      '',
      '- Alice',
      '- Bob',
      '- Carol',
      '',
    ].join('\n'),
    moduleSpec
  )
  assert.equal(data.fields.driver, 'Some text.')
  assert.deepEqual(data.customFields, [
    { id: 'custom:stakeholders', title: 'Stakeholders', type: 'list', value: ['Alice', 'Bob', 'Carol'] },
  ])
  assert.deepEqual(data.layout, [
    { field: 'driver' },
    { custom: { id: 'custom:stakeholders', title: 'Stakeholders', type: 'list', value: ['Alice', 'Bob', 'Carol'] } },
  ])
  assert.deepEqual(data.warnings, [])
})

// Mixed content (some prose, some bullets) stays a plain markdown custom section — the list classification requires every non-empty line to be a bullet.
test('a custom section with mixed prose and bullets stays a plain markdown section', () => {
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
      '## Stakeholders',
      '',
      'Key people involved:',
      '',
      '- Alice',
      '- Bob',
      '',
    ].join('\n'),
    moduleSpec
  )
  assert.deepEqual(data.customFields, [
    { id: 'custom:stakeholders', title: 'Stakeholders', value: 'Key people involved:\n\n- Alice\n- Bob' },
  ])
  // No type property — it's a plain markdown custom section.
  assert.equal(data.customFields[0].type, undefined)
})

// An empty custom section is compatible with being an empty list (a list inserted before any items were added), so it preserves type: 'list' through the round-trip — the rows UI reappears on reload rather than being permanently lost.
test('an empty custom section preserves list type through the round-trip', () => {
  const definition = loadDefinition('design')
  const moduleSpec = definition.modules.get('context')
  const data = parseModuleFile(
    '---\nmodule: context\nstatus: draft\nowner:\n---\n\n## Empty section\n\n\n',
    moduleSpec
  )
  assert.deepEqual(data.customFields, [{ id: 'custom:empty-section', title: 'Empty section', type: 'list', value: [] }])
})

// List-typed custom field round-trip: write with a layout containing a custom list, then read it back — the parser must detect the bullet content as a list field with the same items.
test('list-typed custom field round-trips through write/read with values intact', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const definition = loadDefinition('design')

    writeModule(
      definition,
      'my-initiative',
      'context',
      {
        status: 'draft',
        owner: '',
        fields: {
          driver: 'Because.',
          'affected-domains': [],
          'out-of-scope': '',
        },
        layout: [
          { field: 'driver' },
          { custom: { id: 'custom:stakeholders', title: 'Stakeholders', type: 'list', value: ['Alice', 'Bob'] } },
          { field: 'affected-domains' },
          { field: 'out-of-scope' },
        ],
      },
      { instancesDir }
    )

    // On disk: the custom block sits between Business driver and Affected domains, written as bullets.
    const stored = readFileSync(join(instancesDir, 'my-initiative', 'modules', 'context.md'), 'utf8')
    assert.ok(stored.indexOf('## Stakeholders') > stored.indexOf('## Business driver'))
    assert.ok(stored.indexOf('## Stakeholders') < stored.indexOf('## Affected domains'))
    assert.ok(stored.includes('- Alice'))
    assert.ok(stored.includes('- Bob'))

    // Reading it back yields the same interleaved layout with type: 'list'.
    const data = readModule(definition, 'my-initiative', 'context', { instancesDir })
    assert.deepEqual(data.customFields, [
      { id: 'custom:stakeholders', title: 'Stakeholders', type: 'list', value: ['Alice', 'Bob'] },
    ])
    assert.deepEqual(data.layout, [
      { field: 'driver' },
      { custom: { id: 'custom:stakeholders', title: 'Stakeholders', type: 'list', value: ['Alice', 'Bob'] } },
      { field: 'affected-domains' },
      { field: 'out-of-scope' },
      { field: 'opportunity' },
      { field: 'in-scope' },
    ])
  })
})

// Collision suffixes apply to list-typed custom fields too — two list sections with the same title get -2, -3 suffixes, deterministically.
test('suffixes colliding list-typed custom-field ids', () => {
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
      '## Stakeholders',
      '',
      '- Alice',
      '',
      '## Stakeholders',
      '',
      '- Bob',
      '',
    ].join('\n'),
    moduleSpec
  )
  assert.deepEqual(
    data.customFields.map((f) => f.id),
    ['custom:stakeholders', 'custom:stakeholders-2']
  )
  assert.deepEqual(data.customFields[0], { id: 'custom:stakeholders', title: 'Stakeholders', type: 'list', value: ['Alice'] })
  assert.deepEqual(data.customFields[1], { id: 'custom:stakeholders-2', title: 'Stakeholders', type: 'list', value: ['Bob'] })
  assert.deepEqual(data.warnings, [])
})

// A list-typed custom section interleaved between defined fields records its position in layout.
test('layout records the interleaved order of defined and list-typed custom sections', () => {
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
      '## Business driver',
      '',
      'Text.',
      '',
      '## Stakeholders',
      '',
      '- Alice',
      '- Bob',
      '',
      '## Affected domains',
      '',
      '- Payments',
      '',
    ].join('\n'),
    moduleSpec
  )
  assert.deepEqual(data.layout, [
    { field: 'driver' },
    { custom: { id: 'custom:stakeholders', title: 'Stakeholders', type: 'list', value: ['Alice', 'Bob'] } },
    { field: 'affected-domains' },
  ])
})

// WI 149: removing the last remaining item from a custom-inserted list removes the whole segment — the writer must omit an empty custom list's heading entirely, while schema-defined type:list fields keep their heading even when empty.

// An empty custom list (zero items) is omitted from the persisted file — the segment disappears.
test('an empty custom list is omitted from the written file (WI 149)', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const definition = loadDefinition('design')

    writeModule(
      definition,
      'my-initiative',
      'context',
      {
        status: 'draft',
        owner: '',
        fields: {
          driver: 'Because.',
          'affected-domains': [],
          'out-of-scope': '',
        },
        layout: [
          { field: 'driver' },
          { custom: { id: 'custom:stakeholders', title: 'Stakeholders', type: 'list', value: [] } },
          { field: 'affected-domains' },
          { field: 'out-of-scope' },
        ],
      },
      { instancesDir }
    )

    const stored = readFileSync(join(instancesDir, 'my-initiative', 'modules', 'context.md'), 'utf8')
    assert.ok(!stored.includes('## Stakeholders'), 'empty custom list heading must be omitted')

    // Round-trip: the emptied custom list does not reappear after reload.
    const data = readModule(definition, 'my-initiative', 'context', { instancesDir })
    assert.deepEqual(data.customFields, [])
    assert.deepEqual(data.layout, [
      { field: 'driver' },
      { field: 'affected-domains' },
      { field: 'out-of-scope' },
      { field: 'opportunity' },
      { field: 'in-scope' },
    ])
  })
})

// A custom list emptied to zero items round-trips as removed, while a non-empty one survives.
test('a custom list with one item emptied to zero removes its segment on the next write/read round-trip', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const definition = loadDefinition('design')

    // First, persist a custom list with one item and verify it exists.
    writeModule(
      definition,
      'my-initiative',
      'context',
      {
        status: 'draft',
        owner: '',
        fields: { driver: 'Because.', 'affected-domains': [], 'out-of-scope': '' },
        layout: [
          { field: 'driver' },
          { custom: { id: 'custom:stakeholders', title: 'Stakeholders', type: 'list', value: ['Alice'] } },
          { field: 'affected-domains' },
          { field: 'out-of-scope' },
        ],
      },
      { instancesDir }
    )
    let data = readModule(definition, 'my-initiative', 'context', { instancesDir })
    assert.deepEqual(data.customFields, [
      { id: 'custom:stakeholders', title: 'Stakeholders', type: 'list', value: ['Alice'] },
    ])

    // Simulate removing the last item (value becomes []) and persisting again.
    writeModule(
      definition,
      'my-initiative',
      'context',
      {
        status: 'draft',
        owner: '',
        fields: { driver: 'Because.', 'affected-domains': [], 'out-of-scope': '' },
        layout: [
          { field: 'driver' },
          { custom: { id: 'custom:stakeholders', title: 'Stakeholders', type: 'list', value: [] } },
          { field: 'affected-domains' },
          { field: 'out-of-scope' },
        ],
      },
      { instancesDir }
    )

    const stored = readFileSync(join(instancesDir, 'my-initiative', 'modules', 'context.md'), 'utf8')
    assert.ok(!stored.includes('## Stakeholders'))

    data = readModule(definition, 'my-initiative', 'context', { instancesDir })
    assert.deepEqual(data.customFields, [])
  })
})

// Schema-defined type:list fields must keep preserve-when-empty behaviour unchanged (WI 149 is custom-only).
test('schema-defined type:list heading is preserved even when its value is empty', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const definition = loadDefinition('design')

    writeModule(
      definition,
      'my-initiative',
      'context',
      {
        status: 'draft',
        owner: '',
        fields: {
          driver: 'Because.',
          'affected-domains': [],
          'out-of-scope': '',
        },
        // No custom layout entries — defined fields are emitted in definition order when not in layout.
        layout: [{ field: 'driver' }, { field: 'affected-domains' }, { field: 'out-of-scope' }],
      },
      { instancesDir }
    )

    const stored = readFileSync(join(instancesDir, 'my-initiative', 'modules', 'context.md'), 'utf8')
    assert.ok(stored.includes('## Affected domains'), 'schema-defined list heading must remain even when empty')

    // Clearing a custom list must not affect an adjacent schema-defined empty list.
    writeModule(
      definition,
      'my-initiative',
      'context',
      {
        status: 'draft',
        owner: '',
        fields: { driver: 'Because.', 'affected-domains': [], 'out-of-scope': '' },
        layout: [
          { field: 'driver' },
          { custom: { id: 'custom:extra', title: 'Extra list', type: 'list', value: [] } },
          { field: 'affected-domains' },
          { field: 'out-of-scope' },
        ],
      },
      { instancesDir }
    )

    const stored2 = readFileSync(join(instancesDir, 'my-initiative', 'modules', 'context.md'), 'utf8')
    assert.ok(!stored2.includes('## Extra list'))
    assert.ok(stored2.includes('## Affected domains'))
  })
})

// Mixed: a module with two custom lists, only the emptied one is removed.
test('only the emptied custom list is removed; sibling custom lists remain', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const definition = loadDefinition('design')

    writeModule(
      definition,
      'my-initiative',
      'context',
      {
        status: 'draft',
        owner: '',
        fields: { driver: 'Because.', 'affected-domains': [], 'out-of-scope': '' },
        layout: [
          { field: 'driver' },
          { custom: { id: 'custom:first', title: 'First list', type: 'list', value: ['Alice'] } },
          { custom: { id: 'custom:second', title: 'Second list', type: 'list', value: [] } },
          { field: 'affected-domains' },
          { field: 'out-of-scope' },
        ],
      },
      { instancesDir }
    )

    const stored = readFileSync(join(instancesDir, 'my-initiative', 'modules', 'context.md'), 'utf8')
    assert.ok(stored.includes('## First list'))
    assert.ok(!stored.includes('## Second list'))
    assert.ok(stored.includes('- Alice'))

    const data = readModule(definition, 'my-initiative', 'context', { instancesDir })
    assert.deepEqual(
      data.customFields.map((f) => f.title),
      ['First list']
    )
  })
})

// Mixed prose and bullets in a custom section stays plain — proving the parser doesn't falsely classify it.
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
// These exercise createInstance/readInstance/readModule/writeModule's second storage backend — the Azure DevOps REST API (#84), via the same fake in-process server tests/azureDevOpsClient.test.js uses — instead of the local filesystem, reusing the exact same parseModuleFile/renderModuleFile logic the tests above exercise against disk. Every call here supplies `options.azureDevOps`; every call above doesn't, which is itself part of what proves the two paths are properly independent.

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
    assert.deepEqual(result.modules, ['context', 'solution-definition', 'team-and-estimates', 'dependencies', 'soap-full-details'])

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

// #100: an Azure-DevOps-backed instance's data lives under a per-slug gantry-workspace/<slug>/ subdirectory, not repo root — this is what one repo ("workspace") hosting more than one instance actually depends on.
test('createInstance writes an Azure-DevOps-backed instance under gantry-workspace/<slug>/, not repo root', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    await createInstance('design', 'my-initiative', { azureDevOps })

    const client = createAzureDevOpsClient(azureDevOps)
    const instanceYaml = await client.getFileContent('gantry-workspace/my-initiative/instance.yaml')
    assert.match(instanceYaml, /slug: my-initiative/)
    await client.getFileContent('gantry-workspace/my-initiative/modules/context.md')

    // Nothing at all at the legacy repo-root paths.
    await assert.rejects(() => client.getFileContent('instance.yaml'), AzureDevOpsNotFoundError)
    await assert.rejects(() => client.getFileContent('modules/context.md'), AzureDevOpsNotFoundError)
  })
})

// Acceptance criterion (#100): "A new instance created in a workspace that already has one is written to gantry-workspace/<slug>/, not repo root."
test('a second instance can be created in the same Azure DevOps repo as an existing one, each isolated under its own gantry-workspace/<slug>/', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    await createInstance('design', 'first-initiative', { azureDevOps, owner: 'first-owner' })
    await createInstance('design', 'second-initiative', { azureDevOps, owner: 'second-owner' })

    const firstInstance = await readInstance('first-initiative', { azureDevOps })
    const secondInstance = await readInstance('second-initiative', { azureDevOps })
    assert.equal(firstInstance.slug, 'first-initiative')
    assert.equal(secondInstance.slug, 'second-initiative')

    const definition = loadDefinition('design')
    const firstContext = await readModule(definition, 'first-initiative', 'context', { azureDevOps })
    const secondContext = await readModule(definition, 'second-initiative', 'context', { azureDevOps })
    assert.equal(firstContext.owner, 'first-owner')
    assert.equal(secondContext.owner, 'second-owner')

    // Writing to one instance's module never touches the other's.
    await writeModule(
      definition,
      'first-initiative',
      'context',
      { status: 'review', owner: 'first-owner', fields: { driver: 'First initiative driver.' } },
      { azureDevOps }
    )
    const secondContextAfter = await readModule(definition, 'second-initiative', 'context', { azureDevOps })
    assert.equal(secondContextAfter.status, 'draft')
    assert.equal(secondContextAfter.owner, 'second-owner')

    const client = createAzureDevOpsClient(azureDevOps)
    await client.getFileContent('gantry-workspace/first-initiative/instance.yaml')
    await client.getFileContent('gantry-workspace/second-initiative/instance.yaml')
  })
})

// Defense-in-depth regression test: every real caller of the Azure-DevOps-backed functions below already validates `slug` before reaching them (lib/server.js's isValidSlug for request input, lib/repoCheck.js's own check for a slug discovered from a remote repo) — but these functions must also refuse a path-traversal-shaped slug themselves, rather than silently building a `gantry-workspace/../evil/...` path, in case a future or overlooked caller ever reaches them without validating first.
test('createInstance/readInstance/writeModule/readModule against Azure DevOps reject a path-traversal-shaped slug outright, rather than building a path from it', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    const definition = loadDefinition('design')

    await assert.rejects(() => createInstance('design', '../evil', { azureDevOps }), /Invalid instance slug|invalid instance slug/i)
    await assert.rejects(() => readInstance('../evil', { azureDevOps }), /Invalid instance slug|invalid instance slug/i)
    await assert.rejects(
      () => readModule(definition, '../evil', 'context', { azureDevOps }),
      /Invalid instance slug|invalid instance slug/i
    )
    await assert.rejects(
      () => writeModule(definition, '../evil', 'context', { fields: {} }, { azureDevOps }),
      /Invalid instance slug|invalid instance slug/i
    )

    // Nothing was ever written anywhere as a result of the attempt.
    const client = createAzureDevOpsClient(azureDevOps)
    await assert.rejects(() => client.getFileContent('gantry-workspace/../evil/instance.yaml'), AzureDevOpsNotFoundError)
    await assert.rejects(() => client.getFileContent('evil/instance.yaml'), AzureDevOpsNotFoundError)
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
  // instance.yaml is the 1st push; each first-stage module is one push after that. failAfterPushes: 2 lets instance.yaml + "context" through, then fails the very next push ("solution-definition") with a simulated outage — independent of exactly how many GETs the client makes per push, so this isn't coupled to that implementation detail.
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: {}, failAfterPushes: 2 },
    async (baseUrl) => {
      const azureDevOps = azureDevOpsOptions(baseUrl)
      await assert.rejects(
        () => createInstance('design', 'my-initiative', { azureDevOps }),
        /partially created.*module\(s\) context were written, but module "solution-definition" failed.*writeModule directly for the remaining module\(s\) \(\s*solution-definition, team-and-estimates, dependencies, soap-full-details\)/s
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
    // "hld-submission" belongs to a later stage than "shape" — createInstance above only wrote the Shape-stage modules, so this one genuinely has no saved data yet, on Azure DevOps exactly as it wouldn't on disk.
    await assert.rejects(
      () => readModule(definition, 'my-initiative', 'hld-submission', { azureDevOps }),
      /has no saved data for instance "my-initiative"/
    )
  })
})

// Regression test for a review finding: readModule used to never forward `options.strict` to parseModuleFile on either storage backend, so a caller asking for strict parsing (as evaluateStage's `check` mode does) would silently get non-strict semantics regardless. `strict` must now throw on a parser anomaly the same way on both the local and Azure DevOps-backed paths. The file here is written in the new heading scale (ADR-0016) — an old-scale file's stray headings are folded into field content by the lazy migration before the parser ever sees them (see the migration tests below), so a post-migration anomaly is one that exists in new-scale bytes.
// --- Heading-scale lazy migration (#130, ADR-0016) -------------------------
//
// The new document heading scale: module titles at `#`, field headings at `##`, author content starting at `###`. Pre-existing files were written with bare `##` field headings and no module title; reading one migrates it in place (ADR-0010's migrate-on-read pattern) so no manual step is ever needed.

const OLD_SCALE_CONTEXT = [
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

// The same old-scale file plus two author headings the old scale allowed to collide with the structural one — a `##` that isn't any field's title (which the old parser treated as an unknown phantom section and warned about) and a bare `#`.
const OLD_SCALE_WITH_AUTHOR_HEADINGS = [
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
  '## An author heading the old scale allowed to collide',
  '',
  'Author prose under their own heading.',
  '',
  '## Affected domains',
  '',
  '- Payments',
  '- Client Record',
  '',
  '## Explicitly out of scope',
  '',
  '# A level-one author heading also collides now',
  '',
  'Nothing yet.',
  '',
].join('\n')

test('reading an old-scale module file bumps it to the new heading scale and writes the result back', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const definition = loadDefinition('design')
    const contextPath = join(instancesDir, 'my-initiative', 'modules', 'context.md')
    writeFileSync(contextPath, OLD_SCALE_CONTEXT)

    readModule(definition, 'my-initiative', 'context', { instancesDir })

    const raw = readFileSync(contextPath, 'utf8')
    assert.match(raw, /^# Context$/m)
    assert.match(raw, /^## Business driver$/m)
    assert.match(raw, /^## Affected domains$/m)
    assert.match(raw, /^## Explicitly out of scope$/m)
  })
})

test('migration preserves every field\'s parsed content through the round-trip', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const definition = loadDefinition('design')
    const moduleSpec = definition.modules.get('context')
    writeFileSync(join(instancesDir, 'my-initiative', 'modules', 'context.md'), OLD_SCALE_CONTEXT)

    const before = parseModuleFile(OLD_SCALE_CONTEXT, moduleSpec).fields
    const after = readModule(definition, 'my-initiative', 'context', { instancesDir }).fields
    assert.deepEqual(after, before)

    // And a fresh read/write cycle on the migrated file is still the exact inverse.
    const reread = readModule(definition, 'my-initiative', 'context', { instancesDir }).fields
    assert.deepEqual(reread, before)
  })
})

test('migration folds author sub-headings into field content at ### instead of leaving them as phantom structure', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const definition = loadDefinition('design')
    const contextPath = join(instancesDir, 'my-initiative', 'modules', 'context.md')
    writeFileSync(contextPath, OLD_SCALE_WITH_AUTHOR_HEADINGS)

    readModule(definition, 'my-initiative', 'context', { instancesDir })

    const raw = readFileSync(contextPath, 'utf8')
    // The stray `##` that used to be an unknown-section warning is now author content inside Business driver.
    assert.match(raw, /A new law requires this by June\.\n\n### An author heading the old scale allowed to collide\n/)
    assert.doesNotMatch(raw, /^## An author heading/m)
    // Same for a stray level-one author heading inside Explicitly out of scope.
    assert.match(raw, /### A level-one author heading also collides now\n/)
  })
})

test('a new-scale file reads back byte-identical — migration never rewrites what is already migrated', () => {
  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    const definition = loadDefinition('design')
    const moduleSpec = definition.modules.get('context')
    const contextPath = join(instancesDir, 'my-initiative', 'modules', 'context.md')

    const newText = readFileSync(contextPath, 'utf8')
    assert.equal(migrateModuleHeadingScale(newText, moduleSpec), newText)

    const mtimeBefore = readFileSync(contextPath, 'utf8')
    readModule(definition, 'my-initiative', 'context', { instancesDir })
    assert.equal(readFileSync(contextPath, 'utf8'), mtimeBefore)
  })
})

test('readModule against Azure DevOps performs the same lazy migration, pushing the migrated file as a commit', async () => {
  await withFakeRepo(
    {
      '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
      '/gantry-workspace/my-initiative/modules/context.md': OLD_SCALE_WITH_AUTHOR_HEADINGS,
    },
    async (baseUrl) => {
      const azureDevOps = azureDevOpsOptions(baseUrl)
      const definition = loadDefinition('design')

      const data = await readModule(definition, 'my-initiative', 'context', { azureDevOps })
      // The author sub-heading folded into Business driver comes along as content, not as a phantom section.
      assert.match(data.fields.driver, /^A new law requires this by June\.\n\n### An author heading/)
      assert.deepEqual(data.fields['affected-domains'], ['Payments', 'Client Record'])

      const client = createAzureDevOpsClient(azureDevOps)
      const stored = await client.getFileContent('gantry-workspace/my-initiative/modules/context.md')
      assert.match(stored, /^# Context$/m)
      assert.match(stored, /^## Business driver$/m)
      assert.match(stored, /### An author heading the old scale allowed to collide\n/)
    }
  )
})

test('readModule forwards options.strict to parseModuleFile on both the local and Azure DevOps-backed paths', async () => {
  // A duplicate defined-field heading is the anomaly strict mode exists to catch (#132 made unknown headings legal custom fields, so they can no longer play this role).
  const badModuleText =
    '---\nmodule: context\nstatus: draft\nowner:\n---\n\n# Context\n\n## Business driver\n\nFirst.\n\n## Business driver\n\nSecond.\n'
  const definition = loadDefinition('design')

  withScratchInstances((instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    writeFileSync(join(instancesDir, 'my-initiative', 'modules', 'context.md'), badModuleText)
    assert.throws(
      () => readModule(definition, 'my-initiative', 'context', { instancesDir, strict: true }),
      /duplicate heading/
    )
    // Without strict, the same anomaly warns instead of throwing.
    const data = readModule(definition, 'my-initiative', 'context', { instancesDir })
    assert.equal(data.warnings.length, 1)
  })

  await withFakeRepo(
    {
      '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
      '/gantry-workspace/my-initiative/modules/context.md': badModuleText,
    },
    async (baseUrl) => {
      const azureDevOps = azureDevOpsOptions(baseUrl)
      await assert.rejects(
        () => readModule(definition, 'my-initiative', 'context', { azureDevOps, strict: true }),
        /duplicate heading/
      )
      const data = await readModule(definition, 'my-initiative', 'context', { azureDevOps })
      assert.equal(data.warnings.length, 1)
    }
  )
})

test('a PAT the (fake) Azure DevOps server rejects surfaces from readInstance/readModule/writeModule/createInstance as AzureDevOpsAuthenticationError', async () => {
  await withFakeRepo(
    { '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n' },
    async (baseUrl) => {
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
    }
  )
})

// Branch-aware storage path (#118): every Azure-DevOps-backed function
// above threads `options.azureDevOps.branch` through to the client instead
// of only ever touching the client's own `'main'` default — prep for #122,
// which will pick a real per-stage branch and pass it in here. Every test
// above this point supplies no `branch` at all, proving the default is
// unaffected; these instead supply one explicitly.

test('createInstance/readInstance/readModule/writeModule all write to and read from the caller-supplied branch, not \'main\'', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl, { branch: 'stage/hld-definition' })
    await createInstance('design', 'my-initiative', { azureDevOps, owner: 'c.barlow' })

    // Nothing landed on 'main' — only the branch this call actually targeted.
    const client = createAzureDevOpsClient(azureDevOpsOptions(baseUrl))
    await assert.rejects(
      () => client.getFileContent('/gantry-workspace/my-initiative/instance.yaml'),
      AzureDevOpsNotFoundError
    )
    const onBranch = await client.getFileContent('/gantry-workspace/my-initiative/instance.yaml', {
      branch: 'stage/hld-definition',
    })
    assert.match(onBranch, /slug: my-initiative/)

    const instance = await readInstance('my-initiative', { azureDevOps })
    assert.equal(instance.stage, 'shape')

    const definition = loadDefinition('design')
    await writeModule(
      definition,
      'my-initiative',
      'context',
      { status: 'in-review', owner: 'c.barlow', fields: { driver: 'Because.' } },
      { azureDevOps }
    )
    const data = await readModule(definition, 'my-initiative', 'context', { azureDevOps })
    assert.equal(data.status, 'in-review')
    assert.equal(data.fields.driver, 'Because.')

    // The module write above never touched `main` either.
    await assert.rejects(
      () => client.getFileContent('/gantry-workspace/my-initiative/modules/context.md'),
      AzureDevOpsNotFoundError
    )
  })
})

test('updateInstanceAssignee against Azure DevOps updates instance.yaml on the caller-supplied branch, leaving \'main\' untouched', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const mainAzureDevOps = azureDevOpsOptions(baseUrl)
    await createInstance('design', 'my-initiative', { azureDevOps: mainAzureDevOps })

    const branchAzureDevOps = azureDevOpsOptions(baseUrl, { branch: 'stage/hld-definition' })
    const client = createAzureDevOpsClient(azureDevOpsOptions(baseUrl))
    // Seed the branch with a copy of instance.yaml so updateInstanceAssignee
    // (a read-modify-write) has something to read on that branch.
    const mainText = await client.getFileContent('/gantry-workspace/my-initiative/instance.yaml')
    await client.writeFile('/gantry-workspace/my-initiative/instance.yaml', mainText, {
      branch: 'stage/hld-definition',
    })

    await updateInstanceAssignee('my-initiative', 'c.barlow', { azureDevOps: branchAzureDevOps })

    const updatedOnBranch = await readInstance('my-initiative', { azureDevOps: branchAzureDevOps })
    assert.equal(updatedOnBranch.assignee, 'c.barlow')

    const stillOnMain = await readInstance('my-initiative', { azureDevOps: mainAzureDevOps })
    assert.equal(stillOnMain.assignee, '')
  })
})

test('a module missing on the requested branch is reported as "no saved data", even when it exists on \'main\'', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    await createInstance('design', 'my-initiative', { azureDevOps })

    const definition = loadDefinition('design')
    await assert.rejects(
      () => readModule(definition, 'my-initiative', 'context', { azureDevOps: { ...azureDevOps, branch: 'stage/hld-definition' } }),
      /has no saved data/
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

// --- recordInstanceReviewRequest / recordInstanceReviewStatus (#197) -------

test('recordInstanceReviewRequest and recordInstanceReviewStatus require a Workspace-backed (Azure DevOps) instance', async () => {
  await assert.rejects(
    () => recordInstanceReviewRequest('local-only', 'shape', { workItemId: 1, reviewer: 'a@example.com', status: 'New' }),
    /recordInstanceReviewRequest is for Workspace-backed instances only/
  )
  await assert.rejects(
    () => recordInstanceReviewStatus('local-only', 'shape', 1, 'Active'),
    /recordInstanceReviewStatus is for Workspace-backed instances only/
  )
})

test('recordInstanceReviewRequest appends reviews for a stage, keeping other stages\' review history untouched', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    await createInstance('design', 'my-initiative', { azureDevOps })

    const first = { workItemId: 101, reviewer: 'a@example.com', reviewerDisplayName: 'A', status: 'New' }
    await recordInstanceReviewRequest('my-initiative', 'shape', first, { azureDevOps })
    const second = { workItemId: 102, reviewer: 'b@example.com', reviewerDisplayName: 'B', status: 'New' }
    const after = await recordInstanceReviewRequest('my-initiative', 'shape', second, { azureDevOps })

    assert.deepEqual(after.reviewRequests.shape.map((r) => r.workItemId), [101, 102])

    const instance = await readInstance('my-initiative', { azureDevOps })
    assert.deepEqual(instance.reviewRequests.shape.map((r) => r.workItemId), [101, 102])
    assert.equal(instance.reviewRequests.shape[1].reviewerDisplayName, 'B')
  })
})

test('recordInstanceReviewStatus updates only the matching review\'s status, leaving its other fields and sibling reviews untouched', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    await createInstance('design', 'my-initiative', { azureDevOps })
    await recordInstanceReviewRequest(
      'my-initiative',
      'shape',
      { workItemId: 201, reviewer: 'a@example.com', reviewerDisplayName: 'A', status: 'New' },
      { azureDevOps }
    )
    await recordInstanceReviewRequest(
      'my-initiative',
      'shape',
      { workItemId: 202, reviewer: 'b@example.com', reviewerDisplayName: 'B', status: 'New' },
      { azureDevOps }
    )

    const updated = await recordInstanceReviewStatus('my-initiative', 'shape', 201, 'Active', { azureDevOps })
    const [review201, review202] = updated.reviewRequests.shape
    assert.equal(review201.status, 'Active')
    assert.equal(review201.reviewer, 'a@example.com')
    assert.equal(review202.status, 'New')
  })
})

test('recordInstanceReviewStatus reports a review that does not exist for the stage instead of writing a phantom entry', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    await createInstance('design', 'my-initiative', { azureDevOps })
    await recordInstanceReviewRequest(
      'my-initiative',
      'shape',
      { workItemId: 301, reviewer: 'a@example.com', status: 'New' },
      { azureDevOps }
    )

    await assert.rejects(
      () => recordInstanceReviewStatus('my-initiative', 'shape', 999, 'Active', { azureDevOps }),
      /has no review request for work item #999 on stage "shape"/
    )

    const instance = await readInstance('my-initiative', { azureDevOps })
    assert.equal(instance.reviewRequests.shape.length, 1)
  })
})

test('recordInstanceReviewRequest serializes concurrent writes for the same instance so no request is lost to a stale read', async () => {
  await withFakeRepo({}, async (baseUrl) => {
    const azureDevOps = azureDevOpsOptions(baseUrl)
    await createInstance('design', 'my-initiative', { azureDevOps })

    // Fired without awaiting each other: without the write lock, both would
    // read the same pre-write instance.yaml and the second write would clobber
    // the first reviewer's entry.
    await Promise.all([
      recordInstanceReviewRequest(
        'my-initiative',
        'shape',
        { workItemId: 401, reviewer: 'a@example.com', status: 'New' },
        { azureDevOps }
      ),
      recordInstanceReviewRequest(
        'my-initiative',
        'shape',
        { workItemId: 402, reviewer: 'b@example.com', status: 'New' },
        { azureDevOps }
      ),
    ])

    const instance = await readInstance('my-initiative', { azureDevOps })
    assert.deepEqual(
      instance.reviewRequests.shape.map((r) => r.workItemId).sort((a, b) => a - b),
      [401, 402]
    )
  })
})

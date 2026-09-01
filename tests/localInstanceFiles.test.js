import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  renderInstanceYaml,
  renderModuleFile,
  parseInstanceYaml,
  withInstanceStage,
  parseLocalModuleFile,
  renderLocalModuleInstanceFile,
  buildLocalModuleEntry,
} from '../web/lib/localInstanceFiles.js'
import { parseModuleFile, writeModule } from '../lib/instance.js'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// WI #295 — the wizard's Local + Register path writes a new instance's
// `instance.yaml` / `modules/*.md` in the browser through a directory
// handle. These helpers must produce byte-identical text to
// `lib/instance.js`'s server-side `createInstance` path (its private
// `stringifyInstanceYAML` / `renderModuleFile`), so a folder stays portable
// between a local workspace and a server-hosted Azure DevOps repo.

describe('renderInstanceYaml', () => {
  test('emits canonical (key-sorted) YAML with the same fields createInstance records', () => {
    const yaml = renderInstanceYaml({
      definition: 'solution-on-a-page',
      slug: 'claims',
      stage: 'discovery',
      assignee: 'a.architect',
      definitionVersion: 3,
    })
    assert.equal(
      yaml,
      'assignee: a.architect\n' +
        'definition: solution-on-a-page\n' +
        'definitionVersion: 3\n' +
        'slug: claims\n' +
        'stage: discovery\n'
    )
  })

  test('defaults a missing assignee to an empty string', () => {
    const yaml = renderInstanceYaml({
      definition: 'd',
      slug: 's',
      stage: 'st',
      assignee: '',
      definitionVersion: 1,
    })
    assert.match(yaml, /^assignee: ""\n/)
  })
})

describe('renderModuleFile', () => {
  test('reproduces the blank-module-file format verbatim', () => {
    const spec = {
      id: 'context',
      title: 'Context',
      fields: [{ title: 'Business driver' }, { title: 'Scope' }],
    }
    assert.equal(
      renderModuleFile(spec),
      '---\n' +
        'module: context\n' +
        'status: draft\n' +
        'owner: ""\n' +
        '---\n\n' +
        '# Context\n\n' +
        '## Business driver\n\n' +
        '\n' +
        '## Scope\n\n'
    )
  })

  test('a single-field module has no trailing blank-line separator', () => {
    const out = renderModuleFile({ id: 'm', title: 'M', fields: [{ title: 'Only' }] })
    assert.equal(out, '---\nmodule: m\nstatus: draft\nowner: ""\n---\n\n# M\n\n## Only\n\n')
  })
})

// WI #297 (A6) — the module editor's local-workspace read/write path.
// These exercise the new read-side helpers against `lib/instance.js`'s own
// server-side functions to prove byte-identical / shape-identical behaviour.

describe('parseInstanceYaml / withInstanceStage', () => {
  test('parses instance.yaml into a plain record', () => {
    const record = parseInstanceYaml('definition: solution-on-a-page\nslug: claims\nstage: discovery\nassignee: a.architect\n')
    assert.deepEqual(record, {
      definition: 'solution-on-a-page',
      slug: 'claims',
      stage: 'discovery',
      assignee: 'a.architect',
    })
  })

  test('withInstanceStage replaces stage and re-serializes canonically (key-sorted)', () => {
    const record = parseInstanceYaml('definition: d\nslug: s\nstage: discovery\nassignee: a\n')
    const out = withInstanceStage(record, 'design')
    assert.equal(out, 'assignee: a\ndefinition: d\nslug: s\nstage: design\n')
  })
})

describe('parseLocalModuleFile vs. lib/instance.js parseModuleFile', () => {
  const moduleSpec = {
    id: 'context',
    title: 'Context',
    fields: [
      { id: 'driver', title: 'Business driver', type: 'markdown' },
      { id: 'items', title: 'Scope items', type: 'list' },
    ],
  }

  test('parses frontmatter, defined fields, list fields and custom sections identically to the server parser', () => {
    const text =
      '---\n' +
      'module: context\n' +
      'status: in-review\n' +
      'owner: a.architect\n' +
      '---\n\n' +
      '# Context\n\n' +
      '## Business driver\n\n' +
      'Because reasons.\n\n' +
      '## Scope items\n\n' +
      '- one\n' +
      '- two\n\n' +
      '## A custom note\n\n' +
      'Author-inserted content.\n'

    const server = parseModuleFile(text, moduleSpec)
    const local = parseLocalModuleFile(text, moduleSpec)
    assert.deepEqual(local, server)
  })

  test('throws when the frontmatter fence is missing, matching the server parser', () => {
    assert.throws(() => parseLocalModuleFile('# Context\n', moduleSpec), /missing YAML frontmatter/)
    assert.throws(() => parseModuleFile('# Context\n', moduleSpec), /missing YAML frontmatter/)
  })
})

describe('renderLocalModuleInstanceFile vs. lib/instance.js writeModule', () => {
  test('produces byte-identical text to the server-side save writer', () => {
    const moduleSpec = {
      id: 'context',
      title: 'Context',
      fields: [
        { id: 'driver', title: 'Business driver', type: 'markdown' },
        { id: 'items', title: 'Scope items', type: 'list' },
      ],
    }
    const data = {
      status: 'in-review',
      owner: 'a.architect',
      fields: { driver: 'Because reasons.', items: ['one', 'two'] },
      layout: [{ field: 'driver' }, { field: 'items' }, { custom: { id: 'custom:note', title: 'A note', value: 'Extra.' } }],
    }

    const localText = renderLocalModuleInstanceFile('context', moduleSpec, data)

    const dir = mkdtempSync(join(tmpdir(), 'gantry-localinstancefiles-'))
    try {
      mkdirSync(join(dir, 'inst', 'modules'), { recursive: true })
      const definition = { modules: new Map([['context', moduleSpec]]) }
      writeModule(definition, 'inst', 'context', data, { instancesDir: dir })
      const serverText = readFileSync(join(dir, 'inst', 'modules', 'context.md'), 'utf8')
      assert.equal(localText, serverText)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildLocalModuleEntry vs. lib/server.js buildModuleEntry shape', () => {
  test('emits the same { id, title, purpose, status, owner, fields } shape GET /api/instance returns', () => {
    const moduleSpec = {
      id: 'context',
      title: 'Context',
      purpose: 'Frame the problem.',
      fields: [
        { id: 'driver', title: 'Business driver', type: 'markdown', required: true },
        { id: 'items', title: 'Scope items', type: 'list' },
      ],
    }
    const data = {
      status: 'draft',
      owner: '',
      fields: { driver: 'Because reasons.', items: ['one'] },
      layout: [{ field: 'driver' }, { field: 'items' }],
    }
    const stage = { gate: 'discovery-gate' }
    const entry = buildLocalModuleEntry(moduleSpec, stage, data, null)
    assert.equal(entry.id, 'context')
    assert.equal(entry.title, 'Context')
    assert.equal(entry.purpose, 'Frame the problem.')
    assert.equal(entry.status, 'draft')
    assert.equal(entry.owner, '')
    assert.deepEqual(
      entry.fields.map((f) => ({ id: f.id, value: f.value, required: f.required })),
      [
        { id: 'driver', value: 'Because reasons.', required: true },
        { id: 'items', value: ['one'], required: false },
      ]
    )
  })

  test('a field absent from data.fields defaults to "" / [] per type', () => {
    const moduleSpec = { id: 'm', title: 'M', fields: [{ id: 'a', title: 'A', type: 'markdown' }, { id: 'b', title: 'B', type: 'list' }] }
    const entry = buildLocalModuleEntry(moduleSpec, { gate: 'g' }, { status: 'draft', owner: '', fields: {} }, null)
    assert.deepEqual(entry.fields.map((f) => f.value), ['', []])
  })
})

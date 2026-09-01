import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { renderInstanceYaml, renderModuleFile } from '../web/lib/localInstanceFiles.js'

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

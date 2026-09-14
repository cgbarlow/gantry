import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { withRunningServer } from './helpers/lifecycle.js'
import { getStatus } from '../lib/status.js'
import { checkGate } from '../lib/check.js'
import { renderArtefact } from '../lib/render.js'
import { createBlankDefinition, writeDefinitionVersion } from '../lib/definition.js'
import { runLocalWorkspaceCompute, LocalWorkspaceRequestError, LOCAL_WORKSPACE_TMP_PREFIX } from '../lib/localWorkspace.js'

// WI #384 (Definition Editor phase 4, parent Feature #380): local-workspace
// definitions. These cover the two stateless-endpoint additions the ticket's
// "Done when" asks for — an inline `definition` in an `/api/local/*` payload
// (status/check/render/compile run against a definition that lives only in
// the caller's browser, never in this server's bundled `definitionsDir`) and
// the new `/api/local/definition/validate` route (the same structural rule
// set `POST /api/definitions/:id/versions/:n/validate` runs for a *library*
// draft, under the no-PAT/size-capped `/api/local/*` namespace instead).
//
// The client-side half (`web/lib/localDefinitionFiles.js`'s File System
// Access API read/write, and the local-definition editor page) is covered by
// tests/localDefinitionFiles.test.js and the Playwright spec
// tests/definitionEditorPhase4.playwright.test.js.

const FIXTURE_ID = 'wi384-fixture'
const TEMPLATE_NAME = 'main.md.tmpl'
const TEMPLATE_SOURCE = "# <%= it.instance.definition %> — <%= it.instance.slug %>\n\n## Background\n\n<%= it.modules.background.summary %>\n"

function fixtureStructure({ id = FIXTURE_ID, version = 1, status = 'draft' } = {}) {
  return {
    id,
    title: 'WI384 Fixture',
    description: 'A minimal definition for phase 4 inline-definition tests.',
    version,
    status,
    stages: [{ id: 'shape', title: 'Shape', purpose: 'Shape the idea', gate: 'business-case', modules: ['background'] }],
    artefacts: [{ id: 'soap', title: 'SOAP', purpose: 'Summarise', template: `templates/${TEMPLATE_NAME}`, gate: 'business-case', requires: ['background.summary'] }],
    modules: [
      {
        id: 'background',
        title: 'Background',
        purpose: 'Why this exists',
        fields: [{ id: 'summary', title: 'Summary', type: 'markdown', required: true }],
      },
    ],
  }
}

const FIXTURE_MODULE_TEXT = '---\nmodule: background\nstatus: draft\nowner: \'\'\n---\n\n# Background\n\n## Summary\n\nThe project summary.\n'
const FIXTURE_INSTANCE_YAML = `definition: ${FIXTURE_ID}\nslug: fixture-instance\nstage: shape\nassignee: a.architect\ndefinitionVersion: 1\n`

function fixturePayload(overrides = {}) {
  return {
    definitionId: FIXTURE_ID,
    definitionVersion: 1,
    instanceYaml: FIXTURE_INSTANCE_YAML,
    moduleFiles: { background: FIXTURE_MODULE_TEXT },
    definition: { structure: fixtureStructure(), templates: { [TEMPLATE_NAME]: TEMPLATE_SOURCE } },
    ...overrides,
  }
}

// Materializes the same fixture onto real disk (via the exact
// writeDefinitionVersion/lib file layout an on-disk definition already
// uses) so every inline-definition assertion below has a ground truth to
// diff against, rather than re-deriving "what the endpoint should return"
// by hand.
function withDiskFixture(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'gantry-defs-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    createBlankDefinition(FIXTURE_ID, { definitionsDir })
    writeDefinitionVersion(FIXTURE_ID, 1, fixtureStructure(), { definitionsDir })
    mkdirSync(join(definitionsDir, FIXTURE_ID, '1', 'templates'), { recursive: true })
    writeFileSync(join(definitionsDir, FIXTURE_ID, '1', 'templates', TEMPLATE_NAME), TEMPLATE_SOURCE)
    const workspaceDir = join(instancesDir, 'fixture-instance')
    mkdirSync(join(workspaceDir, 'modules'), { recursive: true })
    writeFileSync(join(workspaceDir, 'instance.yaml'), FIXTURE_INSTANCE_YAML)
    writeFileSync(join(workspaceDir, 'modules', 'background.md'), FIXTURE_MODULE_TEXT)
    return fn({ definitionsDir, instancesDir })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

function tmpSandboxes() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(LOCAL_WORKSPACE_TMP_PREFIX))
}

function post(base, route, body) {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

// ---------------------------------------------------------------------------
// POST /api/local/definition/validate
// ---------------------------------------------------------------------------

test('POST /api/local/definition/validate reports a structurally sound definition as valid', async () => {
  await withRunningServer({}, async (base) => {
    const res = await post(base, '/api/local/definition/validate', { structure: fixtureStructure() })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { definition: FIXTURE_ID, valid: true, problems: [] })
  })
})

test('POST /api/local/definition/validate reports a dangling module reference', async () => {
  await withRunningServer({}, async (base) => {
    const broken = fixtureStructure()
    broken.stages[0].modules = ['no-such-module']
    const res = await post(base, '/api/local/definition/validate', { structure: broken })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.valid, false)
    assert.equal(body.problems.length, 1)
    assert.equal(body.problems[0].type, 'missing-module')
  })
})

test('POST /api/local/definition/validate rejects a missing/non-object structure with 400', async () => {
  await withRunningServer({}, async (base) => {
    const res1 = await post(base, '/api/local/definition/validate', {})
    assert.equal(res1.status, 400)
    const res2 = await post(base, '/api/local/definition/validate', { structure: 'nope' })
    assert.equal(res2.status, 400)
  })
})

test('POST /api/local/definition/validate never writes to the server disk (no sandbox created)', async () => {
  await withRunningServer({}, async (base) => {
    const before = tmpSandboxes()
    await post(base, '/api/local/definition/validate', { structure: fixtureStructure() })
    assert.deepEqual(tmpSandboxes().filter((n) => !before.includes(n)), [])
  })
})

// ---------------------------------------------------------------------------
// Inline `definition` on the existing /api/local/{status,check,render,compile} routes
// ---------------------------------------------------------------------------

test('POST /api/local/status with an inline definition matches getStatus for the equivalent on-disk definition', async () => {
  await withRunningServer({}, async (base) => {
    const res = await post(base, '/api/local/status', fixturePayload())
    assert.equal(res.status, 200)
    const body = await res.json()
    withDiskFixture(({ definitionsDir, instancesDir }) => {
      assert.deepEqual(body, getStatus('fixture-instance', { instancesDir, definitionsDir }))
    })
  })
})

test('POST /api/local/check with an inline definition matches checkGate for the equivalent on-disk definition, and passes', async () => {
  await withRunningServer({}, async (base) => {
    const res = await post(base, '/api/local/check', fixturePayload())
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.pass, true)
    withDiskFixture(({ definitionsDir, instancesDir }) => {
      assert.deepEqual(body, checkGate('fixture-instance', { instancesDir, definitionsDir }))
    })
  })
})

test('POST /api/local/validate (the definitionId lookup form) is unaffected by inline-definition support — still 404s an unknown bundled id', async () => {
  await withRunningServer({}, async (base) => {
    const res = await post(base, '/api/local/validate', { definitionId: FIXTURE_ID })
    assert.equal(res.status, 500)
  })
})

test('POST /api/local/render with an inline definition+templates produces the same markdown/.docx as the equivalent on-disk render, and tears the sandbox down', async () => {
  await withRunningServer({}, async (base) => {
    const before = tmpSandboxes()
    const res = await post(base, '/api/local/render', { ...fixturePayload(), artefact: 'soap' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.artefact, 'soap')
    assert.match(body.markdown, /Background/)
    assert.match(body.markdown, /The project summary\./)
    assert.equal(Buffer.from(body.docxBase64, 'base64').subarray(0, 2).toString(), 'PK')

    withDiskFixture(({ definitionsDir, instancesDir }) => {
      const disk = renderArtefact('fixture-instance', 'soap', { instancesDir, definitionsDir })
      assert.equal(body.markdown, disk.markdown)
      assert.equal(body.basename, disk.basename)
    })
    assert.deepEqual(tmpSandboxes().filter((n) => !before.includes(n)), [])
  })
})

test('POST /api/local/compile with an inline definition+templates matches the markdown POST /api/local/render goes on to convert', async () => {
  await withRunningServer({}, async (base) => {
    const compileRes = await post(base, '/api/local/compile', { ...fixturePayload(), artefact: 'soap' })
    const renderRes = await post(base, '/api/local/render', { ...fixturePayload(), artefact: 'soap' })
    assert.equal(compileRes.status, 200)
    assert.equal(renderRes.status, 200)
    const compileBody = await compileRes.json()
    const renderBody = await renderRes.json()
    assert.equal(compileBody.markdown, renderBody.markdown)
    assert.equal(compileBody.docxBase64, undefined)
  })
})

// ---------------------------------------------------------------------------
// Direct harness unit tests: inline-definition payload validation branches
// ---------------------------------------------------------------------------

const HARNESS_OPTS = { definitionsDir: 'definitions' }

async function expectRequestError(operation, payload, { status, match } = {}) {
  await assert.rejects(runLocalWorkspaceCompute(operation, payload, HARNESS_OPTS), (err) => {
    assert.ok(err instanceof LocalWorkspaceRequestError, `expected LocalWorkspaceRequestError, got ${err}`)
    if (status !== undefined) assert.equal(err.status, status)
    if (match) assert.match(err.message, match)
    return true
  })
}

test('runLocalWorkspaceCompute rejects an inline definition whose structure.id does not match definitionId', async () => {
  await expectRequestError(
    'validate',
    { definitionId: FIXTURE_ID, definition: { structure: fixtureStructure({ id: 'someone-else' }) } },
    { match: /must match definitionId/ }
  )
})

test('runLocalWorkspaceCompute requires a resolvable version for an inline definition', async () => {
  const structure = fixtureStructure()
  delete structure.version
  await expectRequestError('validate', { definitionId: FIXTURE_ID, definition: { structure } }, { match: /positive integer/ })
})

test('runLocalWorkspaceCompute resolves an inline definition\'s version from structure.version when definitionVersion is omitted', async () => {
  const result = await runLocalWorkspaceCompute('validate', { definitionId: FIXTURE_ID, definition: { structure: fixtureStructure() } }, HARNESS_OPTS)
  assert.deepEqual(result, { definition: FIXTURE_ID, valid: true, problems: [] })
})

test('runLocalWorkspaceCompute rejects an oversized definition.structure.modules array with 413', async () => {
  const structure = fixtureStructure()
  structure.modules = Array.from({ length: 201 }, (_, i) => ({ id: `m${i}`, title: 'x', purpose: 'x', fields: [] }))
  await expectRequestError('validate', { definitionId: FIXTURE_ID, definition: { structure } }, { status: 413, match: /Too many definition.structure.modules/ })
})

test('runLocalWorkspaceCompute rejects an invalid inline template name', async () => {
  await expectRequestError(
    'validate',
    { definitionId: FIXTURE_ID, definition: { structure: fixtureStructure(), templates: { 'not-a-template.txt': 'x' } } },
    { match: /Invalid template name/ }
  )
})

test('runLocalWorkspaceCompute rejects an unsafe referenceDocs key', async () => {
  await expectRequestError(
    'validate',
    { definitionId: FIXTURE_ID, definition: { structure: fixtureStructure(), referenceDocs: { '../evil': 'AA==' } } },
    { match: /Unsafe referenceDocs key/ }
  )
})

test('runLocalWorkspaceCompute inline-definition status/render leave no sandbox behind even on a definition problem', async () => {
  const before = tmpSandboxes()
  const broken = fixtureStructure()
  broken.stages[0].modules = ['no-such-module']
  await assert.rejects(
    runLocalWorkspaceCompute(
      'status',
      { definitionId: FIXTURE_ID, instanceYaml: FIXTURE_INSTANCE_YAML, moduleFiles: {}, definition: { structure: broken } },
      HARNESS_OPTS
    )
  )
  assert.deepEqual(tmpSandboxes().filter((n) => !before.includes(n)), [])
})

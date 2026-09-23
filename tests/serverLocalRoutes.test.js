import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { withRunningServer } from './helpers/lifecycle.js'
import { getStatus } from '../lib/status.js'
import { checkGate } from '../lib/check.js'
import { validateDefinition } from '../lib/validate.js'
import {
  LOCAL_WORKSPACE_TMP_PREFIX,
  runLocalWorkspaceCompute,
  LocalWorkspaceRequestError,
} from '../lib/localWorkspace.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// docs/adr/0029 / WI #294: the stateless `/api/local/*` routes let a browser
// holding a local workspace's files on the user's own machine run gantry's
// compute server-side, inside a throwaway temp dir, with no PAT and nothing
// persisted. These assert each route matches what the CLI/`lib` produce for the
// same instance sitting on disk under `workspaces/examples/`, and that the sandbox is
// always torn down.

const DISK_INSTANCE = 'kiwi-cover-mutual'
const DISK_OPTS = { instancesDir: 'workspaces/examples', definitionsDir: 'definitions' }

function payloadFromDiskInstance(slug = DISK_INSTANCE) {
  const dir = join('workspaces/examples', slug)
  const instanceYaml = readFileSync(join(dir, 'instance.yaml'), 'utf8')
  const moduleFiles = {}
  for (const file of readdirSync(join(dir, 'modules'))) {
    if (!file.endsWith('.md')) continue
    // Image references are stripped: a local-workspace payload carries no asset manifest (see helpers/fixtureModules.js).
    moduleFiles[file.replace(/\.md$/, '')] = exampleModuleText(file.replace(/\.md$/, ''))
  }
  // The on-disk fixture is pinned to design v2 (WI #348); the payload must say so or the local routes would evaluate it against v1.
  return { definitionId: 'design', definitionVersion: 2, instanceYaml, moduleFiles }
}

function tmpSandboxes() {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(LOCAL_WORKSPACE_TMP_PREFIX))
}

function post(base, route, body) {
  return fetch(`${base}/api/local/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('POST /api/local/status matches getStatus for the same on-disk instance', async () => {
  await withRunningServer({}, async (base) => {
    const res = await post(base, 'status', payloadFromDiskInstance())
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), getStatus(DISK_INSTANCE, DISK_OPTS))
  })
})

test('POST /api/local/check (explicit gate) matches checkGate, and passes', async () => {
  await withRunningServer({}, async (base) => {
    const res = await post(base, 'check', { ...payloadFromDiskInstance(), gate: 'business-case' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.pass, true)
    assert.deepEqual(body, checkGate(DISK_INSTANCE, { ...DISK_OPTS, gate: 'business-case' }))
  })
})

test('POST /api/local/check with no gate derives it from the instance stage', async () => {
  await withRunningServer({}, async (base) => {
    const res = await post(base, 'check', payloadFromDiskInstance())
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.pass, true)
    assert.deepEqual(body, checkGate(DISK_INSTANCE, DISK_OPTS))
  })
})

test('POST /api/local/validate matches validateDefinition for the bundled definition', async () => {
  await withRunningServer({}, async (base) => {
    const res = await post(base, 'validate', { definitionId: 'design', definitionVersion: 1 })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.valid, true)
    assert.deepEqual(body, validateDefinition('design', { definitionsDir: 'definitions', version: 1 }))
  })
})

test('POST /api/local/render returns non-empty markdown and a .docx that decodes to a PK zip', async () => {
  await withRunningServer({}, async (base) => {
    const before = tmpSandboxes()
    const res = await post(base, 'render', { ...payloadFromDiskInstance(), artefact: 'soap' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.artefact, 'soap')
    assert.ok(body.markdown.length > 0, 'markdown should be non-empty')
    assert.match(body.markdown, /Solution on a Page/)
    const docx = Buffer.from(body.docxBase64, 'base64')
    assert.equal(docx.subarray(0, 2).toString(), 'PK', '.docx should start with a PK zip header')
    // Sandbox torn down after a successful request.
    assert.deepEqual(tmpSandboxes().filter((n) => !before.includes(n)), [])
  })
})

// WI314 — /api/local/compile is /api/local/render's dry-run sibling for the client-side WASM
// Pandoc render path: markdown + which reference-doc file to fetch, no `pandoc` subprocess, no
// docxBase64 at all (the browser produces that itself).
test('POST /api/local/compile returns non-empty markdown, a reference-doc, and no docxBase64 — no pandoc subprocess involved', async () => {
  await withRunningServer({}, async (base) => {
    const before = tmpSandboxes()
    const res = await post(base, 'compile', { ...payloadFromDiskInstance(), artefact: 'soap' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.artefact, 'soap')
    assert.ok(body.markdown.length > 0, 'markdown should be non-empty')
    assert.match(body.markdown, /Solution on a Page/)
    assert.match(body.markdown, /## Document Control/)
    assert.equal(body.docxBase64, undefined)
    assert.equal(typeof body.referenceDocBase64, 'string')
    // A real reference.docx, not just an opaque non-empty string — same PK zip signature the
    // /api/local/render docx assertion checks.
    assert.equal(Buffer.from(body.referenceDocBase64, 'base64').subarray(0, 2).toString(), 'PK')
    // Sandbox torn down after a successful request, same as every other /api/local/* op.
    assert.deepEqual(tmpSandboxes().filter((n) => !before.includes(n)), [])
  })
})

test('POST /api/local/compile produces the exact markdown POST /api/local/render goes on to convert with pandoc', async () => {
  await withRunningServer({}, async (base) => {
    const compileRes = await post(base, 'compile', { ...payloadFromDiskInstance(), artefact: 'soap' })
    const renderRes = await post(base, 'render', { ...payloadFromDiskInstance(), artefact: 'soap' })
    const compileBody = await compileRes.json()
    const renderBody = await renderRes.json()
    // Both compiled independently (different temp sandboxes, different commit-info reads at
    // slightly different instants) — the Document Control commit hash/date can legitimately
    // differ between them only if run across a real commit boundary, which never happens in a
    // test run, so the two markdown strings are byte-identical here.
    assert.equal(compileBody.markdown, renderBody.markdown)
    assert.equal(compileBody.basename, renderBody.basename)
  })
})

test('an oversized request body is rejected with 413 and leaves no sandbox behind', async () => {
  await withRunningServer({}, async (base) => {
    const before = tmpSandboxes()
    const huge = 'x'.repeat(11 * 1024 * 1024)
    const res = await post(base, 'status', { ...payloadFromDiskInstance(), moduleFiles: { background: huge } })
    assert.equal(res.status, 413)
    assert.match((await res.json()).error, /limit/i)
    assert.deepEqual(tmpSandboxes().filter((n) => !before.includes(n)), [])
  })
})

test('too many moduleFiles is rejected with 4xx before anything is written', async () => {
  await withRunningServer({}, async (base) => {
    const before = tmpSandboxes()
    const moduleFiles = {}
    for (let i = 0; i < 201; i++) moduleFiles[`m${i}`] = '## x\n'
    const res = await post(base, 'status', { ...payloadFromDiskInstance(), moduleFiles })
    assert.ok(res.status === 413 || res.status === 400, `expected 4xx, got ${res.status}`)
    assert.deepEqual(tmpSandboxes().filter((n) => !before.includes(n)), [])
  })
})

test('a moduleFiles key of ../evil is rejected with 400 and nothing is written', async () => {
  await withRunningServer({}, async (base) => {
    const before = tmpSandboxes()
    const res = await post(base, 'status', {
      ...payloadFromDiskInstance(),
      moduleFiles: { '../evil': 'pwned' },
    })
    assert.equal(res.status, 400)
    assert.match((await res.json()).error, /unsafe|filename/i)
    assert.deepEqual(tmpSandboxes().filter((n) => !before.includes(n)), [])
  })
})

test('a failing request (unknown artefact) still tears the sandbox down', async () => {
  await withRunningServer({}, async (base) => {
    const before = tmpSandboxes()
    const res = await post(base, 'render', { ...payloadFromDiskInstance(), artefact: 'no-such-artefact' })
    assert.equal(res.status, 500)
    assert.deepEqual(tmpSandboxes().filter((n) => !before.includes(n)), [])
  })
})

test('GET on a /api/local/* route is not handled as a compute request', async () => {
  await withRunningServer({}, async (base) => {
    const res = await fetch(`${base}/api/local/status`)
    // Not a 200 compute result — this route only handles POST. It's still a JSON error rather
    // than the app shell, per the /api/ 404 guard (#141), not the earlier HTML fallback.
    assert.notEqual(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  })
})

// --- Direct harness unit tests: payload validation branches ----------------

const HARNESS_OPTS = { definitionsDir: 'definitions' }

async function expectRequestError(operation, payload, { status, match } = {}) {
  await assert.rejects(runLocalWorkspaceCompute(operation, payload, HARNESS_OPTS), (err) => {
    assert.ok(err instanceof LocalWorkspaceRequestError, `expected LocalWorkspaceRequestError, got ${err}`)
    if (status !== undefined) assert.equal(err.status, status)
    if (match) assert.match(err.message, match)
    return true
  })
}

test('runLocalWorkspaceCompute rejects an unknown operation with 404', async () => {
  await expectRequestError('frobnicate', {}, { status: 404 })
})

test('runLocalWorkspaceCompute rejects non-object / missing payload pieces', async () => {
  await expectRequestError('validate', null, { match: /Request body must be an object/ })
  await expectRequestError('validate', {}, { match: /definitionId is required/ })
  await expectRequestError('validate', { definitionId: '../design' }, { match: /Invalid definitionId/ })
  await expectRequestError('validate', { definitionId: 'design', definitionVersion: 0 }, { match: /Invalid definitionVersion/ })
  await expectRequestError('validate', { definitionId: 'design', definitionVersion: 'x' }, { match: /Invalid definitionVersion/ })
})

test('runLocalWorkspaceCompute rejects malformed moduleFiles / assets collections', async () => {
  const base = { definitionId: 'design', instanceYaml: 'slug: local\nstage: shape\n' }
  await expectRequestError('status', { ...base, moduleFiles: [] }, { match: /moduleFiles must be an object/ })
  await expectRequestError('status', { ...base, moduleFiles: { ok: 5 } }, { match: /must be a string/ })
  await expectRequestError('status', { ...base, assets: {} }, { match: /assets must be an array/ })
  await expectRequestError('status', { ...base, assets: ['nope'] }, { match: /each asset must be an object/ })
  await expectRequestError('status', { ...base, assets: [{ id: '../x', base64: '' }] }, { match: /Unsafe asset id/ })
  await expectRequestError('status', { ...base, assets: [{ id: 'ok.png', base64: 5 }] }, { match: /base64 string/ })
})

test('runLocalWorkspaceCompute requires a usable instanceYaml for non-validate operations', async () => {
  await expectRequestError('status', { definitionId: 'design' }, { match: /instanceYaml is required/ })
  await expectRequestError('status', { definitionId: 'design', instanceYaml: 42 }, { match: /instanceYaml must be a string/ })
  await expectRequestError(
    'status',
    { definitionId: 'design', instanceYaml: ':\n  bad: [' },
    { match: /instanceYaml is not valid YAML/ }
  )
  await expectRequestError(
    'status',
    { definitionId: 'design', instanceYaml: '- a\n- b\n' },
    { match: /instanceYaml must describe a mapping/ }
  )
})

test('runLocalWorkspaceCompute requires artefact for render/compile and a stage for status/check/compile', async () => {
  const yaml = 'slug: local\nstage: shape\n'
  await expectRequestError('render', { definitionId: 'design', instanceYaml: yaml }, { match: /artefact is required/ })
  await expectRequestError('compile', { definitionId: 'design', instanceYaml: yaml }, { match: /artefact is required/ })
  await expectRequestError(
    'status',
    { definitionId: 'design', instanceYaml: 'slug: local\n' },
    { match: /must set "stage"/ }
  )
  await expectRequestError(
    'check',
    { definitionId: 'design', instanceYaml: 'slug: local\n' },
    { match: /must set "stage", or pass "gate"/ }
  )
  await expectRequestError(
    'compile',
    { definitionId: 'design', instanceYaml: 'slug: local\n', artefact: 'soap' },
    { match: /must set "stage"/ }
  )
})

test('runLocalWorkspaceCompute falls back to slug "local" when instanceYaml carries no valid slug', async () => {
  const result = await runLocalWorkspaceCompute(
    'check',
    { definitionId: 'design', instanceYaml: 'stage: shape\nslug: "nested/slug"\n', gate: 'business-case' },
    HARNESS_OPTS
  )
  assert.equal(result.slug, 'local')
  assert.equal(result.pass, false)
})

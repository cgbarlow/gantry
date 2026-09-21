import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGantryClient } from '../src/gantryClient.js'
import { tools } from '../src/tools/definitions.tools.js'
import { stubFetch } from './helpers/fakeFetch.js'

function tool(name) {
  const found = tools.find((t) => t.name === name)
  assert.ok(found, `tool "${name}" not registered`)
  return found
}

const listDefinitionsTool = tool('list_definitions')
const getDefinitionTool = tool('get_definition')
const updateDefinitionTool = tool('update_definition')
const createDraftVersionTool = tool('create_draft_version')
const validateDefinitionTool = tool('validate_definition')
const publishDefinitionVersionTool = tool('publish_definition_version')
const promoteDefinitionTool = tool('promote_definition')

function client({ workspacePats = {} } = {}) {
  return createGantryClient({ baseUrl: 'https://gantry.example.test', workspacePats })
}

// ---- list_definitions ----------------------------------------------------

test('list_definitions passes archived/includeWorkspaces through and returns the merged rows', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/definitions') {
      assert.equal(url.searchParams.get('archived'), '1')
      assert.equal(url.searchParams.get('includeWorkspaces'), '1')
      return { status: 200, body: [{ id: 'design', title: 'Design' }, { id: 'ops', title: 'Ops', home: { kind: 'server-workspace', id: 'srv-1' } }] }
    }
    return undefined
  })
  try {
    const result = await listDefinitionsTool.handler({ includeArchived: true, includeWorkspaces: true }, { gantryClient: client() })
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.definitions.length, 2)
  } finally {
    fetch.restore()
  }
})

test('list_definitions omits query params by default', async () => {
  const fetch = stubFetch(({ url }) => {
    assert.equal(url.searchParams.get('archived'), null)
    assert.equal(url.searchParams.get('includeWorkspaces'), null)
    return { status: 200, body: [] }
  })
  try {
    await listDefinitionsTool.handler({}, { gantryClient: client() })
  } finally {
    fetch.restore()
  }
})

test('list_definitions surfaces an upstream error rather than throwing', async () => {
  const fetch = stubFetch(() => ({ status: 500, body: { error: 'boom' } }))
  try {
    const result = await listDefinitionsTool.handler({}, { gantryClient: client() })
    assert.equal(result.isError, true)
    assert.match(JSON.parse(result.content[0].text).error, /500/)
  } finally {
    fetch.restore()
  }
})

// ---- get_definition -------------------------------------------------------

test('get_definition returns the same structure the visual editor reads (library route)', async () => {
  const doc = { id: 'design', title: 'Design', description: null, version: 1, status: 'draft', stages: [], artefacts: [], modules: [] }
  const fetch = stubFetch(({ url, method }) => {
    assert.equal(method, 'GET')
    assert.equal(url.pathname, '/api/definitions/design/versions/1')
    return { status: 200, body: doc }
  })
  try {
    const result = await getDefinitionTool.handler({ id: 'design', version: 1 }, { gantryClient: client() })
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(result.content[0].text), doc)
  } finally {
    fetch.restore()
  }
})

test('get_definition targets the Provider-backed workspace route family when workspaceId is given', async () => {
  const fetch = stubFetch(({ url, headers }) => {
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-1', provider: 'github' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/workspaces/ws-1/definitions/design/versions/2') {
      assert.equal(headers.authorization, 'Basic ' + Buffer.from(':secret-pat').toString('base64'))
      return { status: 200, body: { id: 'design', version: 2 } }
    }
    return undefined
  })
  try {
    const result = await getDefinitionTool.handler(
      { id: 'design', version: 2, workspaceId: 'ws-1' },
      { gantryClient: client({ workspacePats: { 'ws-1': 'secret-pat' } }) }
    )
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(result.content[0].text), { id: 'design', version: 2 })
  } finally {
    fetch.restore()
  }
})

test('get_definition surfaces credentialError without ever calling the target path', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-2', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    return undefined
  })
  try {
    const result = await getDefinitionTool.handler({ id: 'design', version: 1, workspaceId: 'ws-2' }, { gantryClient: client() })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.error, 'missing_workspace_pat')
    assert.equal(payload.workspace, 'ws-2')
    assert.equal(
      fetch.calls.some((c) => c.url.pathname.includes('/definitions/design/')),
      false
    )
  } finally {
    fetch.restore()
  }
})

test('get_definition surfaces a 404 as an upstream error', async () => {
  const fetch = stubFetch(() => ({ status: 404, body: { error: 'Definition "nope" has no version 1' } }))
  try {
    const result = await getDefinitionTool.handler({ id: 'nope', version: 1 }, { gantryClient: client() })
    assert.equal(result.isError, true)
    assert.match(JSON.parse(result.content[0].text).error, /404/)
  } finally {
    fetch.restore()
  }
})

// ---- update_definition -----------------------------------------------------

test('update_definition accepts a structurally valid document', async () => {
  const fetch = stubFetch(({ url, method, body }) => {
    assert.equal(method, 'PUT')
    assert.equal(url.pathname, '/api/definitions/design/versions/3')
    const parsed = JSON.parse(body)
    assert.deepEqual(parsed, { stages: [], artefacts: [], modules: [] })
    return { status: 200, body: { ok: true, version: 3 } }
  })
  try {
    const result = await updateDefinitionTool.handler(
      { id: 'design', version: 3, stages: [], artefacts: [], modules: [] },
      { gantryClient: client() }
    )
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, version: 3 })
  } finally {
    fetch.restore()
  }
})

test('update_definition rejects a structurally invalid document with the editor\'s problem list', async () => {
  const problems = [{ type: 'missing-module', message: 'Stage "s1" references module "nope", which does not exist in this definition' }]
  const fetch = stubFetch(() => ({ status: 422, body: { problems } }))
  try {
    const result = await updateDefinitionTool.handler(
      { id: 'design', version: 3, stages: [{ id: 's1', modules: ['nope'] }], artefacts: [], modules: [] },
      { gantryClient: client() }
    )
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /422/)
    assert.deepEqual(payload.detail.problems, problems)
  } finally {
    fetch.restore()
  }
})

test('update_definition refuses a published (non-draft) version with a 409-shaped error', async () => {
  const fetch = stubFetch(() => ({ status: 409, body: { error: 'Version 3 of "design" is not a draft (status: published)' } }))
  try {
    const result = await updateDefinitionTool.handler(
      { id: 'design', version: 3, stages: [], artefacts: [], modules: [] },
      { gantryClient: client() }
    )
    assert.equal(result.isError, true)
    assert.match(JSON.parse(result.content[0].text).error, /409/)
  } finally {
    fetch.restore()
  }
})

test('update_definition writes into a Provider-backed workspace when workspaceId is given', async () => {
  const fetch = stubFetch(({ url, method }) => {
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-1', provider: 'github' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/workspaces/ws-1/definitions/design/versions/1' && method === 'PUT') {
      return { status: 200, body: { ok: true } }
    }
    return undefined
  })
  try {
    const result = await updateDefinitionTool.handler(
      { id: 'design', version: 1, workspaceId: 'ws-1', stages: [], artefacts: [], modules: [] },
      { gantryClient: client({ workspacePats: { 'ws-1': 'p' } }) }
    )
    assert.equal(result.isError, undefined)
  } finally {
    fetch.restore()
  }
})

// ---- create_draft_version ---------------------------------------------------

test('create_draft_version produces a new version without needing a body', async () => {
  const fetch = stubFetch(({ url, method, body }) => {
    assert.equal(method, 'POST')
    assert.equal(url.pathname, '/api/definitions/design/versions')
    assert.equal(body, undefined)
    return { status: 200, body: { id: 'design', version: 2, status: 'draft' } }
  })
  try {
    const result = await createDraftVersionTool.handler({ id: 'design' }, { gantryClient: client() })
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(result.content[0].text), { id: 'design', version: 2, status: 'draft' })
  } finally {
    fetch.restore()
  }
})

test('create_draft_version surfaces an archived-definition rejection', async () => {
  const fetch = stubFetch(() => ({ status: 400, body: { error: 'Definition "design" is archived' } }))
  try {
    const result = await createDraftVersionTool.handler({ id: 'design' }, { gantryClient: client() })
    assert.equal(result.isError, true)
  } finally {
    fetch.restore()
  }
})

test('create_draft_version targets a Provider-backed workspace when workspaceId is given', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-1', provider: 'github' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/workspaces/ws-1/definitions/design/versions') return { status: 200, body: { version: 2 } }
    return undefined
  })
  try {
    const result = await createDraftVersionTool.handler({ id: 'design', workspaceId: 'ws-1' }, { gantryClient: client({ workspacePats: { 'ws-1': 'p' } }) })
    assert.equal(result.isError, undefined)
  } finally {
    fetch.restore()
  }
})

// ---- validate_definition ----------------------------------------------------

test('validate_definition returns an empty problems array for a sound document', async () => {
  const fetch = stubFetch(({ url, method, body }) => {
    assert.equal(method, 'POST')
    assert.equal(url.pathname, '/api/definitions/design/versions/1/validate')
    assert.deepEqual(JSON.parse(body), { stages: [], artefacts: [], modules: [] })
    return { status: 200, body: { problems: [] } }
  })
  try {
    const result = await validateDefinitionTool.handler({ id: 'design', version: 1, stages: [], artefacts: [], modules: [] }, { gantryClient: client() })
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(result.content[0].text), { problems: [] })
  } finally {
    fetch.restore()
  }
})

test('validate_definition surfaces outstanding problems for a version', async () => {
  const problems = [{ type: 'unknown-field-type', message: 'Module "m1" field "f1" has unknown type "bogus" (expected "markdown" or "list")' }]
  const fetch = stubFetch(() => ({ status: 200, body: { problems } }))
  try {
    const result = await validateDefinitionTool.handler(
      { id: 'design', version: 1, stages: [], artefacts: [], modules: [{ id: 'm1', fields: [{ id: 'f1', type: 'bogus' }] }] },
      { gantryClient: client() }
    )
    assert.deepEqual(JSON.parse(result.content[0].text).problems, problems)
  } finally {
    fetch.restore()
  }
})

test('validate_definition defaults missing arrays to empty', async () => {
  const fetch = stubFetch(({ body }) => {
    assert.deepEqual(JSON.parse(body), { stages: [], artefacts: [], modules: [] })
    return { status: 200, body: { problems: [] } }
  })
  try {
    await validateDefinitionTool.handler({ id: 'design', version: 1 }, { gantryClient: client() })
  } finally {
    fetch.restore()
  }
})

// ---- publish_definition_version ---------------------------------------------

test('publish_definition_version makes a draft the live version', async () => {
  const fetch = stubFetch(({ url, method }) => {
    assert.equal(method, 'POST')
    assert.equal(url.pathname, '/api/definitions/design/versions/2/publish')
    return { status: 200, body: { ok: true, version: 2, status: 'published' } }
  })
  try {
    const result = await publishDefinitionVersionTool.handler({ id: 'design', version: 2 }, { gantryClient: client() })
    assert.equal(result.isError, undefined)
    assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, version: 2, status: 'published' })
  } finally {
    fetch.restore()
  }
})

test('publish_definition_version rejects an invalid draft with the problem list (422)', async () => {
  const problems = [{ type: 'missing-module', message: 'boom' }]
  const fetch = stubFetch(() => ({ status: 422, body: { problems } }))
  try {
    const result = await publishDefinitionVersionTool.handler({ id: 'design', version: 2 }, { gantryClient: client() })
    assert.equal(result.isError, true)
    assert.deepEqual(JSON.parse(result.content[0].text).detail.problems, problems)
  } finally {
    fetch.restore()
  }
})

test('publish_definition_version publishes inside a Provider-backed workspace when workspaceId is given', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-1', provider: 'gitlab' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/workspaces/ws-1/definitions/design/versions/1/publish') return { status: 200, body: { ok: true } }
    return undefined
  })
  try {
    const result = await publishDefinitionVersionTool.handler(
      { id: 'design', version: 1, workspaceId: 'ws-1' },
      { gantryClient: client({ workspacePats: { 'ws-1': 'p' } }) }
    )
    assert.equal(result.isError, undefined)
  } finally {
    fetch.restore()
  }
})

test('publish_definition_version surfaces credentialError for an unknown workspace id', async () => {
  const fetch = stubFetch(({ url }) => {
    if (url.pathname === '/api/workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    return undefined
  })
  try {
    const result = await publishDefinitionVersionTool.handler({ id: 'design', version: 1, workspaceId: 'does-not-exist' }, { gantryClient: client() })
    assert.equal(result.isError, true)
    assert.equal(JSON.parse(result.content[0].text).error, 'workspace_not_found')
  } finally {
    fetch.restore()
  }
})

// ---- promote_definition -------------------------------------------------------

test('promote_definition opens a PR per selected library repo', async () => {
  const results = [
    { ok: true, repoId: 'repo-a', pullRequestUrl: 'https://example.test/pr/1' },
    { ok: false, repoId: 'repo-b', error: 'missing_library_pat' },
  ]
  const fetch = stubFetch(({ url, method, body }) => {
    assert.equal(method, 'POST')
    assert.equal(url.pathname, '/api/definitions/ops/versions/1/promote')
    assert.deepEqual(JSON.parse(body), { repoIds: ['repo-a', 'repo-b'] })
    return { status: 200, body: { promotions: [{ repoId: 'repo-a', pullRequestUrl: 'https://example.test/pr/1' }], results } }
  })
  try {
    const result = await promoteDefinitionTool.handler({ id: 'ops', version: 1, repoIds: ['repo-a', 'repo-b'] }, { gantryClient: client() })
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.deepEqual(payload.results, results)
  } finally {
    fetch.restore()
  }
})

test('promote_definition surfaces the "only for a published workspace definition" rejection', async () => {
  const fetch = stubFetch(() => ({ status: 400, body: { error: 'Promote is only available for a published workspace definition version.' } }))
  try {
    const result = await promoteDefinitionTool.handler({ id: 'design', version: 1, repoIds: ['repo-a'] }, { gantryClient: client() })
    assert.equal(result.isError, true)
    assert.match(JSON.parse(result.content[0].text).error, /400/)
  } finally {
    fetch.restore()
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createAzureDevOpsClient,
  AzureDevOpsAuthenticationError,
  AzureDevOpsNotFoundError,
  AzureDevOpsRequestError,
  DEFAULT_BASE_URL,
} from '../lib/azureDevOpsClient.js'
import { createFakeAzureDevOpsServer, withFakeAzureDevOpsServer as withFakeServer } from './helpers/fakeAzureDevOpsServer.js'

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'

// Mirrors tests/server.test.js's withRunningServer helper's shape (per
// #82's testing decisions), but for the fake Azure DevOps server instead
// of gantry's own — a real HTTP server on an ephemeral port, hit with real
// `fetch` calls, never a mock of `fetch` internals. Pins this file's fixed
// organization/project/repository/PAT constants so call sites below only
// need to supply `files`.
function withFakeAzureDevOpsServer(files, fn) {
  return withFakeServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files }, fn)
}

function client(baseUrl, overrides = {}) {
  return createAzureDevOpsClient({
    organization: ORGANIZATION,
    project: PROJECT,
    repository: REPOSITORY,
    pat: VALID_PAT,
    baseUrl,
    ...overrides,
  })
}

test('getFileContent fetches an existing file\'s content by path', async () => {
  await withFakeAzureDevOpsServer({ '/instance.yaml': 'slug: demo\n' }, async (baseUrl) => {
    const content = await client(baseUrl).getFileContent('/instance.yaml')
    assert.equal(content, 'slug: demo\n')
  })
})

test('getFileContent works with a path missing its leading slash', async () => {
  await withFakeAzureDevOpsServer({ '/modules/context.md': '# Context\n' }, async (baseUrl) => {
    const content = await client(baseUrl).getFileContent('modules/context.md')
    assert.equal(content, '# Context\n')
  })
})

test('getFileContent throws AzureDevOpsNotFoundError for a path with no item', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    await assert.rejects(() => client(baseUrl).getFileContent('/missing.md'), AzureDevOpsNotFoundError)
  })
})

test('writeFile creates a new file that did not exist before', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const result = await c.writeFile('/modules/context.md', '# Hello\n', { message: 'Add context module' })
    assert.equal(result.changeType, 'add')
    assert.equal(await c.getFileContent('/modules/context.md'), '# Hello\n')
  })
})

test('writeFile updates an existing file\'s content (a push)', async () => {
  await withFakeAzureDevOpsServer({ '/modules/context.md': 'old content\n' }, async (baseUrl) => {
    const c = client(baseUrl)
    const result = await c.writeFile('/modules/context.md', 'new content\n', { message: 'Update context module' })
    assert.equal(result.changeType, 'edit')
    assert.equal(await c.getFileContent('/modules/context.md'), 'new content\n')
  })
})

test('writeFile survives a second write to the same path (branch ref moves forward each push)', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    await c.writeFile('/modules/context.md', 'v1\n')
    await c.writeFile('/modules/context.md', 'v2\n')
    assert.equal(await c.getFileContent('/modules/context.md'), 'v2\n')
  })
})

// Regression test for a fake-server bug found in review: an earlier version
// of objectIdFor (tests/helpers/fakeAzureDevOpsServer.js) end-padded a hex
// encoding of the commit count with zeroes, which is not actually
// collision-free — e.g. commit 1 ("1" + 39 zeroes) and commit 16 ("10" + 38
// zeroes) produced the exact same 40-character id. That would silently
// break the optimistic-concurrency (oldObjectId) check any real Azure
// DevOps repo relies on, and any test asserting on a commit id's
// uniqueness, once a fake-server session crossed 16 pushes.
test('writeFile assigns a distinct newObjectId to every one of many pushes against the same fake server, never repeating one', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const seen = new Set()
    for (let i = 0; i < 20; i++) {
      const result = await c.writeFile('/modules/context.md', `v${i}\n`)
      assert.equal(seen.has(result.push.refUpdates[0].newObjectId), false, `newObjectId repeated at push ${i}`)
      seen.add(result.push.refUpdates[0].newObjectId)
    }
    assert.equal(seen.size, 20)
  })
})

test('writeFile with contentType: "base64encoded" pushes binary content (e.g. a rendered .docx), not raw text', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    const bytes = Buffer.from('PK\x03\x04 fake docx bytes', 'binary')
    const result = await c.writeFile('/out/soap.docx', bytes.toString('base64'), {
      contentType: 'base64encoded',
      message: 'Render soap',
    })
    assert.equal(result.changeType, 'add')
    const pushedContent = await c.getFileContent('/out/soap.docx')
    assert.equal(Buffer.from(pushedContent, 'base64').toString('binary'), bytes.toString('binary'))
  })
})

test('base URL defaults to the real Azure DevOps API but is configurable/overridable for tests', async () => {
  assert.equal(DEFAULT_BASE_URL, 'https://dev.azure.com')
  assert.equal(client(undefined).baseUrl, 'https://dev.azure.com')

  await withFakeAzureDevOpsServer({ '/instance.yaml': 'slug: demo\n' }, async (baseUrl) => {
    const c = client(baseUrl)
    assert.equal(c.baseUrl, baseUrl)
    // Proves the override actually took effect: a real call succeeds
    // against the fake server on this non-default base URL.
    assert.equal(await c.getFileContent('/instance.yaml'), 'slug: demo\n')
  })
})

test('a PAT the (fake) server rejects surfaces as AzureDevOpsAuthenticationError, distinct from other errors', async () => {
  await withFakeAzureDevOpsServer({ '/instance.yaml': 'slug: demo\n' }, async (baseUrl) => {
    const badClient = client(baseUrl, { pat: 'a-pat-the-server-does-not-recognize' })
    await assert.rejects(() => badClient.getFileContent('/instance.yaml'), AzureDevOpsAuthenticationError)
  })
})

test('a rejected PAT is reported distinctly from a not-found path, on the same client', async () => {
  await withFakeAzureDevOpsServer({ '/instance.yaml': 'slug: demo\n' }, async (baseUrl) => {
    const goodClient = client(baseUrl)
    await assert.rejects(() => goodClient.getFileContent('/does-not-exist.md'), AzureDevOpsNotFoundError)

    const badClient = client(baseUrl, { pat: 'wrong' })
    await assert.rejects(() => badClient.getFileContent('/instance.yaml'), AzureDevOpsAuthenticationError)

    // The two failure modes are genuinely distinct classes, not the same
    // error with a different message.
    assert.notEqual(AzureDevOpsAuthenticationError, AzureDevOpsNotFoundError)
  })
})

test('a rejected PAT on writeFile also surfaces as AzureDevOpsAuthenticationError', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const badClient = client(baseUrl, { pat: 'wrong' })
    await assert.rejects(() => badClient.writeFile('/modules/context.md', 'content\n'), AzureDevOpsAuthenticationError)
  })
})

test('a network failure reaching the Azure DevOps API surfaces as AzureDevOpsRequestError, not the auth or not-found errors', async () => {
  // Nothing listens on this port — a real connection failure, not a mock
  // of fetch — exercising the client's network-error branch, distinct
  // from the HTTP-level auth/not-found branches covered above.
  const unreachableBaseUrl = 'http://127.0.0.1:1'
  const c = client(unreachableBaseUrl)
  await assert.rejects(() => c.getFileContent('/instance.yaml'), AzureDevOpsRequestError)
})

test('organisation and project names containing URL-reserved characters (space, "&", "#", "?") are encoded, not misparsed as a URL fragment/query', async () => {
  // A project name is free text in Azure DevOps and can contain any of
  // these — unlike the fixed ORGANIZATION/PROJECT constants used by every
  // other test here, which are plain slugs that would pass even without
  // encoding.
  const organization = 'fake-org'
  const project = 'Q&A #1?'
  const repository = 'fake-repo'

  await new Promise((resolve, reject) => {
    const server = createFakeAzureDevOpsServer({
      organization,
      project,
      repository,
      validPat: VALID_PAT,
      files: { '/instance.yaml': 'slug: demo\n' },
    })
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        const c = createAzureDevOpsClient({
          organization,
          project,
          repository,
          pat: VALID_PAT,
          baseUrl: `http://localhost:${port}`,
        })
        assert.equal(await c.getFileContent('/instance.yaml'), 'slug: demo\n')
        await c.writeFile('/modules/context.md', '# Hello\n')
        assert.equal(await c.getFileContent('/modules/context.md'), '# Hello\n')
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
})

test('createAzureDevOpsClient requires organization, project, repository and pat', () => {
  assert.throws(() => createAzureDevOpsClient({ project: PROJECT, repository: REPOSITORY, pat: VALID_PAT }), /organization/)
  assert.throws(() => createAzureDevOpsClient({ organization: ORGANIZATION, repository: REPOSITORY, pat: VALID_PAT }), /project/)
  assert.throws(() => createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, pat: VALID_PAT }), /repository/)
  assert.throws(() => createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY }), /pat/)
})

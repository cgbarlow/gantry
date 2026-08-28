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

// Mirrors tests/server.test.js's withRunningServer helper's shape (per #82's testing decisions), but for the fake Azure DevOps server instead of gantry's own — a real HTTP server on an ephemeral port, hit with real `fetch` calls, never a mock of `fetch` internals. Pins this file's fixed organization/project/repository/PAT constants so call sites below only need to supply `files`.
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

test('getLatestCommit returns the newest commit for the requested branch', async () => {
  await withFakeAzureDevOpsServer({ '/instance.yaml': 'v1\n' }, async (baseUrl) => {
    const c = client(baseUrl)
    await c.writeFile('/instance.yaml', 'v2\n')

    const commit = await c.getLatestCommit()
    assert.equal(commit.comment, 'Update /instance.yaml')
    assert.equal(typeof commit.committer.date, 'string')
    assert.equal(await c.getLatestCommit({ branch: 'missing' }), null)
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

// Regression test for a fake-server bug found in review: an earlier version of objectIdFor (tests/helpers/fakeAzureDevOpsServer.js) end-padded a hex encoding of the commit count with zeroes, which is not actually collision-free — e.g. commit 1 ("1" + 39 zeroes) and commit 16 ("10" + 38 zeroes) produced the exact same 40-character id. That would silently break the optimistic-concurrency (oldObjectId) check any real Azure DevOps repo relies on, and any test asserting on a commit id's uniqueness, once a fake-server session crossed 16 pushes.
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
    // Proves the override actually took effect: a real call succeeds against the fake server on this non-default base URL.
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

    // The two failure modes are genuinely distinct classes, not the same error with a different message.
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
  // Nothing listens on this port — a real connection failure, not a mock of fetch — exercising the client's network-error branch, distinct from the HTTP-level auth/not-found branches covered above.
  const unreachableBaseUrl = 'http://127.0.0.1:1'
  const c = client(unreachableBaseUrl)
  await assert.rejects(() => c.getFileContent('/instance.yaml'), AzureDevOpsRequestError)
})

test('organisation and project names containing URL-reserved characters (space, "&", "#", "?") are encoded, not misparsed as a URL fragment/query', async () => {
  // A project name is free text in Azure DevOps and can contain any of these — unlike the fixed ORGANIZATION/PROJECT constants used by every other test here, which are plain slugs that would pass even without encoding.
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

// listFolder/deleteFile back lib/repoCheck.js's legacy-root-to-gantry-workspace/<slug>/ migration (#100).

test('listFolder lists the immediate children of a folder, distinguishing files from subfolders', async () => {
  await withFakeAzureDevOpsServer(
    {
      '/gantry-workspace/foo/instance.yaml': 'slug: foo\n',
      '/gantry-workspace/foo/modules/context.md': '# Context\n',
      '/gantry-workspace/bar/instance.yaml': 'slug: bar\n',
    },
    async (baseUrl) => {
      const c = client(baseUrl)
      const entries = await c.listFolder('/gantry-workspace')
      const byPath = Object.fromEntries(entries.map((e) => [e.path, e.isFolder]))
      assert.deepEqual(byPath, { '/gantry-workspace/bar': true, '/gantry-workspace/foo': true })
    }
  )
})

test('listFolder lists files (not just folders) directly inside the scoped path', async () => {
  await withFakeAzureDevOpsServer(
    {
      '/gantry-workspace/foo/modules/context.md': '# Context\n',
      '/gantry-workspace/foo/modules/solution-definition.md': '# Solution\n',
    },
    async (baseUrl) => {
      const c = client(baseUrl)
      const entries = await c.listFolder('/gantry-workspace/foo/modules')
      const byPath = Object.fromEntries(entries.map((e) => [e.path, e.isFolder]))
      assert.deepEqual(byPath, {
        '/gantry-workspace/foo/modules/context.md': false,
        '/gantry-workspace/foo/modules/solution-definition.md': false,
      })
    }
  )
})

test('listFolder returns an empty array (not an error) for a folder that does not exist', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const entries = await client(baseUrl).listFolder('/gantry-workspace')
    assert.deepEqual(entries, [])
  })
})

// Regression test for #116: the real Azure DevOps Items API includes the
// queried folder itself (`scopePath`, isFolder: true) as one of the
// `value` entries alongside its immediate children — previously
// unfiltered, this made every single-instance gantry-workspace/<slug>/
// workspace look like it held more than one instance, since
// `gantry-workspace` itself came back as an extra "folder" alongside the
// one genuine `<slug>` subfolder.
test('listFolder does not include the queried folder itself among its results, only its immediate children', async () => {
  await withFakeAzureDevOpsServer(
    { '/gantry-workspace/my-initiative/instance.yaml': 'slug: my-initiative\n' },
    async (baseUrl) => {
      const entries = await client(baseUrl).listFolder('/gantry-workspace')
      const byPath = Object.fromEntries(entries.map((e) => [e.path, e.isFolder]))
      assert.deepEqual(byPath, { '/gantry-workspace/my-initiative': true })
    }
  )
})

test('deleteFile removes an existing file', async () => {
  await withFakeAzureDevOpsServer({ '/instance.yaml': 'slug: demo\n' }, async (baseUrl) => {
    const c = client(baseUrl)
    await c.deleteFile('/instance.yaml', { message: 'Remove legacy instance.yaml' })
    await assert.rejects(() => c.getFileContent('/instance.yaml'), AzureDevOpsNotFoundError)
  })
})

test('a rejected PAT on listFolder/deleteFile also surfaces as AzureDevOpsAuthenticationError', async () => {
  await withFakeAzureDevOpsServer({ '/instance.yaml': 'slug: demo\n' }, async (baseUrl) => {
    const badClient = client(baseUrl, { pat: 'wrong' })
    await assert.rejects(() => badClient.listFolder('/gantry-workspace'), AzureDevOpsAuthenticationError)
    await assert.rejects(() => badClient.deleteFile('/instance.yaml'), AzureDevOpsAuthenticationError)
  })
})

// Branch-aware storage path (#118): getFileContent/writeFile/listFolder/
// deleteFile all accept a `branch` option (default `'main'`) — these prove
// the fake server itself genuinely isolates one branch's content from
// another, the same way real Azure DevOps branches do, rather than every
// branch name secretly sharing the one flat store every test above (which
// never passes `branch` at all, so exercises only the default) implicitly
// relied on before #118.

test('getFileContent/writeFile default to \'main\' when no branch is given, exactly as every existing caller assumes', async () => {
  await withFakeAzureDevOpsServer({ '/instance.yaml': 'on: main\n' }, async (baseUrl) => {
    const c = client(baseUrl)
    assert.equal(await c.getFileContent('/instance.yaml'), 'on: main\n')
    assert.equal(await c.getFileContent('/instance.yaml', { branch: 'main' }), 'on: main\n')
  })
})

test('writeFile to a non-default branch does not affect \'main\', and vice versa', async () => {
  await withFakeAzureDevOpsServer({ '/instance.yaml': 'on: main\n' }, async (baseUrl) => {
    const c = client(baseUrl)
    await c.writeFile('/instance.yaml', 'on: feature\n', { branch: 'feature/foo', message: 'Write on a branch' })

    assert.equal(await c.getFileContent('/instance.yaml'), 'on: main\n')
    assert.equal(await c.getFileContent('/instance.yaml', { branch: 'feature/foo' }), 'on: feature\n')

    await c.writeFile('/instance.yaml', 'on: main v2\n', { message: 'Update main' })
    assert.equal(await c.getFileContent('/instance.yaml'), 'on: main v2\n')
    // The branch write from earlier is untouched by this second `main` push.
    assert.equal(await c.getFileContent('/instance.yaml', { branch: 'feature/foo' }), 'on: feature\n')
  })
})

test('getFileContent throws AzureDevOpsNotFoundError for a path that exists on a different branch but not the requested one', async () => {
  await withFakeAzureDevOpsServer({ '/instance.yaml': 'on: main\n' }, async (baseUrl) => {
    const c = client(baseUrl)
    await assert.rejects(
      () => c.getFileContent('/instance.yaml', { branch: 'not-created-yet' }),
      AzureDevOpsNotFoundError
    )
  })
})

test('writeFile creates a brand-new branch from an empty state, not seeded from \'main\' or any other existing branch', async () => {
  await withFakeAzureDevOpsServer(
    { '/gantry-workspace/foo/instance.yaml': 'slug: foo\n' },
    async (baseUrl) => {
      const c = client(baseUrl)
      await c.writeFile('/gantry-workspace/foo/other.md', 'only on new-branch\n', { branch: 'new-branch' })

      // The file that was only ever on `main` doesn't leak onto the new branch.
      await assert.rejects(
        () => c.getFileContent('/gantry-workspace/foo/instance.yaml', { branch: 'new-branch' }),
        AzureDevOpsNotFoundError
      )
      assert.equal(
        await c.getFileContent('/gantry-workspace/foo/other.md', { branch: 'new-branch' }),
        'only on new-branch\n'
      )
    }
  )
})

test('listFolder is scoped to the requested branch, not every branch\'s combined content', async () => {
  await withFakeAzureDevOpsServer(
    { '/gantry-workspace/main-only/instance.yaml': 'slug: main-only\n' },
    async (baseUrl) => {
      const c = client(baseUrl)
      await c.writeFile('/gantry-workspace/branch-only/instance.yaml', 'slug: branch-only\n', { branch: 'feature' })

      const mainEntries = await c.listFolder('/gantry-workspace')
      assert.deepEqual(
        mainEntries.map((e) => e.path),
        ['/gantry-workspace/main-only']
      )

      const branchEntries = await c.listFolder('/gantry-workspace', { branch: 'feature' })
      assert.deepEqual(
        branchEntries.map((e) => e.path),
        ['/gantry-workspace/branch-only']
      )
    }
  )
})

test('deleteFile on one branch does not remove the same path from another branch', async () => {
  await withFakeAzureDevOpsServer({ '/instance.yaml': 'on: main\n' }, async (baseUrl) => {
    const c = client(baseUrl)
    await c.writeFile('/instance.yaml', 'on: feature\n', { branch: 'feature' })

    await c.deleteFile('/instance.yaml', { branch: 'feature' })

    await assert.rejects(() => c.getFileContent('/instance.yaml', { branch: 'feature' }), AzureDevOpsNotFoundError)
    assert.equal(await c.getFileContent('/instance.yaml'), 'on: main\n')
  })
})

test('writing to the same branch twice moves that branch\'s own ref forward independently of any other branch', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    const c = client(baseUrl)
    await c.writeFile('/f.md', 'main v1\n')
    await c.writeFile('/f.md', 'branch v1\n', { branch: 'feature' })
    await c.writeFile('/f.md', 'main v2\n')
    await c.writeFile('/f.md', 'branch v2\n', { branch: 'feature' })

    assert.equal(await c.getFileContent('/f.md'), 'main v2\n')
    assert.equal(await c.getFileContent('/f.md', { branch: 'feature' }), 'branch v2\n')
  })
})

test('createFakeAzureDevOpsServer\'s branchFiles option seeds a non-main branch directly, without an initial real push', async () => {
  await withFakeServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { '/instance.yaml': 'on: main\n' },
      branchFiles: { 'stage/hld-definition': { '/instance.yaml': 'on: stage branch\n' } },
    },
    async (baseUrl) => {
      const c = client(baseUrl)
      assert.equal(await c.getFileContent('/instance.yaml'), 'on: main\n')
      assert.equal(await c.getFileContent('/instance.yaml', { branch: 'stage/hld-definition' }), 'on: stage branch\n')
    }
  )
})

// createBranch backs the per-stage branch lifecycle (#119/#122): a stage's
// branch is created either fresh from `main`, or stacked on an
// in-progress earlier stage's branch.

test('createBranch creates a new branch pointing at the source branch\'s current tip', async () => {
  await withFakeAzureDevOpsServer({ '/instance.yaml': 'slug: demo\n' }, async (baseUrl) => {
    const c = client(baseUrl)
    const first = await c.createBranch('gantry-workspace/demo/shape')
    // Main hasn't moved between the two calls, so a second branch created
    // from it independently must land on the exact same commit as the
    // first — the actual proof createBranch reads "from"'s live tip
    // rather than returning some placeholder/derived value.
    const second = await c.createBranch('gantry-workspace/demo/other', { from: 'main' })

    assert.equal(first.name, 'gantry-workspace/demo/shape')
    assert.equal(first.from, 'main')
    assert.equal(typeof first.objectId, 'string')
    assert.equal(first.objectId.length, 40)
    assert.equal(first.objectId, second.objectId)
  })
})

test('createBranch defaults to branching from "main" when no source branch is given', async () => {
  await withFakeAzureDevOpsServer({ '/instance.yaml': 'slug: demo\n' }, async (baseUrl) => {
    const c = client(baseUrl)
    const result = await c.createBranch('feature-x')
    assert.equal(result.from, 'main')
  })
})

test('createBranch can stack a new branch on another (non-main) branch, not just on main', async () => {
  await withFakeAzureDevOpsServer({ '/instance.yaml': 'slug: demo\n' }, async (baseUrl) => {
    const c = client(baseUrl)
    const shapeBranch = await c.createBranch('gantry-workspace/demo/shape')
    const hldBranch = await c.createBranch('gantry-workspace/demo/hld', { from: 'gantry-workspace/demo/shape' })

    assert.equal(hldBranch.from, 'gantry-workspace/demo/shape')
    // Stacked branch starts out pointing at the same commit as the branch
    // it was stacked on, since no new commit was made in between.
    assert.equal(hldBranch.objectId, shapeBranch.objectId)
  })
})

test('createBranch throws AzureDevOpsNotFoundError when the source branch does not exist', async () => {
  await withFakeAzureDevOpsServer({}, async (baseUrl) => {
    // No files seeded — "main" itself has no commits yet.
    await assert.rejects(() => client(baseUrl).createBranch('feature-x'), AzureDevOpsNotFoundError)
  })
})

test('createBranch throws AzureDevOpsRequestError when the branch name already exists', async () => {
  await withFakeAzureDevOpsServer({ '/instance.yaml': 'slug: demo\n' }, async (baseUrl) => {
    const c = client(baseUrl)
    await c.createBranch('feature-x')
    await assert.rejects(() => c.createBranch('feature-x'), AzureDevOpsRequestError)
  })
})

test('createBranch surfaces a rejected PAT as AzureDevOpsAuthenticationError', async () => {
  await withFakeAzureDevOpsServer({ '/instance.yaml': 'slug: demo\n' }, async (baseUrl) => {
    const badClient = client(baseUrl, { pat: 'wrong' })
    await assert.rejects(() => badClient.createBranch('feature-x'), AzureDevOpsAuthenticationError)
  })
})

test('a network failure reaching the Azure DevOps API surfaces as AzureDevOpsRequestError on createBranch too', async () => {
  const unreachableBaseUrl = 'http://127.0.0.1:1'
  const c = client(unreachableBaseUrl)
  await assert.rejects(() => c.createBranch('feature-x'), AzureDevOpsRequestError)
})

test('createAzureDevOpsClient requires organization, project, repository and pat', () => {
  assert.throws(() => createAzureDevOpsClient({ project: PROJECT, repository: REPOSITORY, pat: VALID_PAT }), /organization/)
  assert.throws(() => createAzureDevOpsClient({ organization: ORGANIZATION, repository: REPOSITORY, pat: VALID_PAT }), /project/)
  assert.throws(() => createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, pat: VALID_PAT }), /repository/)
  assert.throws(() => createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY }), /pat/)
})

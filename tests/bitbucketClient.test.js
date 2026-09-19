import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createBitbucketClient,
  BitbucketAuthenticationError,
  BitbucketNotFoundError,
  BitbucketRepoNotFoundError,
} from '../lib/bitbucketClient.js'
import { AuthenticationError, NotFoundError, RepoNotFoundError, RequestError } from '../lib/providerErrors.js'
import { withFakeBitbucketServer, BITBUCKET_OWNER, BITBUCKET_REPOSITORY, BITBUCKET_VALID_PAT } from './helpers/fakeBitbucketServer.js'

// lib/bitbucketClient.js's content-store capability (#41, ADR-0042): proving a token reaches a real
// repository (getRepo/repoExists), reading an existing file/folder over Bitbucket's own Source API,
// writing one or several files as a single commit over its multipart /src endpoint, and the per-stage
// branch lifecycle's own primitives (getBranchObjectId/branchExists/createBranch). Exercised over real
// `fetch` against tests/helpers/fakeBitbucketServer.js, never a mocked `fetch`, mirroring
// tests/gitlabClient.test.js's own conventions — adapted throughout to Bitbucket Cloud's actual API
// shape (Bearer-only auth, hash-addressed content reads, a distinct 403-vs-404 repo-lookup contract)
// rather than assuming GitLab's own shape carries over unchanged; see lib/bitbucketClient.js's own
// module doc comment for the specific differences each adaptation exists to cover.

test('createBitbucketClient requires owner, repository and pat', () => {
  assert.throws(() => createBitbucketClient({ repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT }), /"owner" is required/)
  assert.throws(() => createBitbucketClient({ owner: BITBUCKET_OWNER, pat: BITBUCKET_VALID_PAT }), /"repository" is required/)
  assert.throws(() => createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY }), /"pat" is required/)
  // Synchronously, not left to fail on the first request — an empty string is as absent as `undefined`.
  assert.throws(() => createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: '' }), /"pat" is required/)
})

// ---------- getRepo / repoExists ----------

test('getRepo resolves the repository metadata when the token is accepted and the repository exists', async () => {
  await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT }, async (baseUrl) => {
    const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
    const repo = await client.getRepo()
    assert.equal(repo.name, BITBUCKET_REPOSITORY)
    assert.equal(repo.full_name, `${BITBUCKET_OWNER}/${BITBUCKET_REPOSITORY}`)
  })
})

test('repoExists is true when the repository exists and the token is accepted', async () => {
  await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT }, async (baseUrl) => {
    const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
    assert.equal(await client.repoExists(), true)
  })
})

test('getRepo throws BitbucketAuthenticationError when Bitbucket rejects the token', async () => {
  await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT }, async (baseUrl) => {
    const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: 'wrong-token', baseUrl })
    await assert.rejects(() => client.getRepo(), BitbucketAuthenticationError)
  })
})

test('getRepo throws BitbucketRepoNotFoundError when the repository does not exist', async () => {
  await withFakeBitbucketServer(
    { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, repoExists: false },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      await assert.rejects(() => client.getRepo(), BitbucketRepoNotFoundError)
    }
  )
})

test("getRepo's not-found error is also catchable as the neutral RepoNotFoundError, tagged atlassian", async () => {
  await withFakeBitbucketServer(
    { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, repoExists: false },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      await assert.rejects(() => client.getRepo(), (err) => {
        assert.ok(err instanceof RepoNotFoundError)
        assert.equal(err.provider, 'atlassian')
        return true
      })
    }
  )
})

test('repoExists is false, not thrown, when the repository does not exist', async () => {
  await withFakeBitbucketServer(
    { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, repoExists: false },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      assert.equal(await client.repoExists(), false)
    }
  )
})

test('a self-hosted-shaped baseUrl (a host + /2.0 path) is honoured as-is', async () => {
  await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT }, async (baseUrl) => {
    // The fake server serves its own /2.0 route already — this proves the client sends requests to
    // exactly the baseUrl it was given, the same convention tests substitute for api.bitbucket.org.
    const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
    assert.equal(client.baseUrl, baseUrl)
    await client.getRepo()
  })
})

// ---------- getFileContent / fileExists / listFolder ----------

test('getFileContent reads an existing file back unchanged', async () => {
  await withFakeBitbucketServer(
    {
      owner: BITBUCKET_OWNER,
      repository: BITBUCKET_REPOSITORY,
      validPat: BITBUCKET_VALID_PAT,
      files: { 'definitions/design/1/definition.yaml': 'id: design\n' },
    },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      const content = await client.getFileContent('definitions/design/1/definition.yaml')
      assert.equal(content, 'id: design\n')
    }
  )
})

test('getFileContent on a missing path throws the neutral NotFoundError, tagged atlassian', async () => {
  await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT }, async (baseUrl) => {
    const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
    await assert.rejects(() => client.getFileContent('does/not/exist.yaml'), (err) => {
      assert.ok(err instanceof BitbucketNotFoundError)
      assert.ok(err instanceof NotFoundError, 'also catchable as the neutral NotFoundError')
      assert.equal(err.provider, 'atlassian')
      return true
    })
  })
})

test('getFileContent on a directory path throws NotFoundError (a directory is not a file)', async () => {
  await withFakeBitbucketServer(
    {
      owner: BITBUCKET_OWNER,
      repository: BITBUCKET_REPOSITORY,
      validPat: BITBUCKET_VALID_PAT,
      files: { 'definitions/design/1/definition.yaml': 'id: design\n' },
    },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      await assert.rejects(() => client.getFileContent('definitions/design'), BitbucketNotFoundError)
    }
  )
})

// One of #41's three required normalized-error scenarios: a read against a branch that has never
// existed at all — distinct from a missing path on a real branch, but the same neutral NotFoundError.
test('getFileContent on a branch that does not exist throws NotFoundError (a branch-not-found read)', async () => {
  await withFakeBitbucketServer(
    { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files: { 'x.md': 'x\n' } },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      await assert.rejects(() => client.getFileContent('x.md', { branch: 'no-such-branch' }), (err) => {
        assert.ok(err instanceof BitbucketNotFoundError)
        assert.equal(err.provider, 'atlassian')
        return true
      })
    }
  )
})

test('fileExists is true after a file is present, false for an unwritten path, and false on a branch that does not exist', async () => {
  await withFakeBitbucketServer(
    { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files: { 'exists.md': 'x\n' } },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      assert.equal(await client.fileExists('exists.md'), true)
      assert.equal(await client.fileExists('does-not-exist.md'), false)
      assert.equal(await client.fileExists('exists.md', 'no-such-branch'), false)
    }
  )
})

test('listFolder lists immediate children only, sorted by path, and [] for a folder that does not exist', async () => {
  await withFakeBitbucketServer(
    {
      owner: BITBUCKET_OWNER,
      repository: BITBUCKET_REPOSITORY,
      validPat: BITBUCKET_VALID_PAT,
      files: {
        'definitions/design/1/definition.yaml': 'id: design\n',
        'definitions/design/2/definition.yaml': 'id: design\n',
        'definitions/widget/1/definition.yaml': 'id: widget\n',
      },
    },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      const top = await client.listFolder('definitions')
      assert.deepEqual(top.map((e) => e.path).sort(), ['definitions/design', 'definitions/widget'])
      assert.ok(top.every((e) => e.isFolder))

      const designVersions = await client.listFolder('definitions/design')
      assert.deepEqual(designVersions.map((e) => e.path), ['definitions/design/1', 'definitions/design/2'])

      assert.deepEqual(await client.listFolder('definitions/nope'), [])
    }
  )
})

test('listFolder on a file path returns [] (a file is not a folder)', async () => {
  await withFakeBitbucketServer(
    { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files: { 'notes/hello.md': 'hi\n' } },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      assert.deepEqual(await client.listFolder('notes/hello.md'), [])
    }
  )
})

// The second of #41's three required normalized-error scenarios: an authentication failure, exercised
// here against the read path (a rejected token surfaces identically on the write path further below).
test('a rejected token surfaces as the neutral AuthenticationError, tagged atlassian', async () => {
  await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT }, async (baseUrl) => {
    const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: 'wrong-token', baseUrl })
    await assert.rejects(() => client.getFileContent('anything.md'), (err) => {
      assert.ok(err instanceof BitbucketAuthenticationError)
      assert.ok(err instanceof AuthenticationError)
      assert.equal(err.provider, 'atlassian')
      return true
    })
  })
})

// ---------- writeFile / writeFiles ----------

test('writeFile creates a new file, then getFileContent reads it back unchanged', async () => {
  await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT }, async (baseUrl) => {
    const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
    const result = await client.writeFile('notes/hello.md', 'hello world\n')
    assert.equal(result.changeType, 'add')
    assert.ok(result.push.commits[0].commitId)
    assert.equal(await client.getFileContent('notes/hello.md'), 'hello world\n')
  })
})

test('writeFile on an already-existing path reports changeType "edit", and getFileContent reads the new content', async () => {
  await withFakeBitbucketServer(
    { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files: { 'notes/hello.md': 'v1\n' } },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      const result = await client.writeFile('notes/hello.md', 'v2\n')
      assert.equal(result.changeType, 'edit')
      assert.equal(await client.getFileContent('notes/hello.md'), 'v2\n')
    }
  )
})

test('writeFiles lands several files in exactly one commit, leaving an untouched sibling file byte-identical', async () => {
  await withFakeBitbucketServer(
    { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files: { 'modules/untouched.md': 'unchanged\n' } },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      const { changes, push } = await client.writeFiles(
        [
          { path: 'modules/a.md', content: 'a content\n' },
          { path: 'modules/b.md', content: 'b content\n' },
        ],
        { message: 'Save two modules' }
      )
      assert.equal(changes.length, 2)
      assert.ok(changes.every((c) => c.changeType === 'add'))
      // One commit id covers both files — the "one Save is one commit" contract.
      assert.equal(typeof push.commits[0].commitId, 'string')

      assert.equal(await client.getFileContent('modules/a.md'), 'a content\n')
      assert.equal(await client.getFileContent('modules/b.md'), 'b content\n')
      assert.equal(await client.getFileContent('modules/untouched.md'), 'unchanged\n')
    }
  )
})

test('writeFiles targets a non-default branch without touching main', async () => {
  await withFakeBitbucketServer(
    {
      owner: BITBUCKET_OWNER,
      repository: BITBUCKET_REPOSITORY,
      validPat: BITBUCKET_VALID_PAT,
      files: { 'main-only.md': 'main\n' },
      branchFiles: { 'feature-branch': { 'main-only.md': 'main\n' } },
    },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      await client.writeFile('branch-only.md', 'branch\n', { branch: 'feature-branch' })
      assert.equal(await client.fileExists('branch-only.md', 'feature-branch'), true)
      assert.equal(await client.fileExists('branch-only.md', 'main'), false)
    }
  )
})

// gantry's own stage branches are named `gantry-workspace/<slug>/<stageId>` — see
// lib/bitbucketClient.js's own "Branch names containing '/'" doc comment for why this needs its own
// coverage rather than trusting GitLab-style "just URL-encode it" to carry over.
test('a slash-containing branch name (a gantry stage-branch shape) reads and writes correctly', async () => {
  await withFakeBitbucketServer(
    { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files: { 'instance.yaml': 'stage: shape\n' } },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      const branch = 'gantry-workspace/demo/shape'
      await client.createBranch(branch)
      await client.writeFile('instance.yaml', 'stage: hld-define\n', { branch })
      assert.equal(await client.getFileContent('instance.yaml', { branch }), 'stage: hld-define\n')
      // main is untouched by the branch's own commit.
      assert.equal(await client.getFileContent('instance.yaml', { branch: 'main' }), 'stage: shape\n')
      assert.deepEqual(await client.listFolder('', { branch }), [{ path: 'instance.yaml', isFolder: false }])
    }
  )
})

test('a rejected token on writeFile surfaces as the neutral AuthenticationError, tagged atlassian', async () => {
  await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT }, async (baseUrl) => {
    const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: 'wrong-token', baseUrl })
    await assert.rejects(() => client.writeFile('x.md', 'x\n'), (err) => {
      assert.ok(err instanceof BitbucketAuthenticationError)
      assert.equal(err.provider, 'atlassian')
      return true
    })
  })
})

test('deleteFile removes an existing file, and a delete on a path that never existed is a harmless no-op', async () => {
  await withFakeBitbucketServer(
    { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files: { 'notes/gone.md': 'bye\n' } },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      await client.deleteFile('notes/gone.md')
      assert.equal(await client.fileExists('notes/gone.md'), false)

      // No files ever existed there — writeFiles' own multipart request is short-circuited before any
      // network call, the same "an empty changelist is never sent" tolerance as lib/gitlabClient.js.
      await client.deleteFile('notes/never-existed.md')
    }
  )
})

test('writeFile on a binary (base64encoded) file round-trips real bytes unchanged', async () => {
  await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT }, async (baseUrl) => {
    const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
    const bytes = Buffer.from([0, 1, 2, 255, 254, 253])
    await client.writeFile('assets/binary.dat', bytes.toString('base64'), { contentType: 'base64encoded' })
    const readBack = await client.getFileBytes('assets/binary.dat')
    assert.deepEqual(readBack, bytes)
  })
})

// ---------- getBranchObjectId / branchExists / createBranch ----------

test('branchExists is false for a branch that has never existed, and getBranchObjectId reports null for it', async () => {
  await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT }, async (baseUrl) => {
    const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
    assert.equal(await client.branchExists('gantry-workspace/demo/shape'), false)
    assert.equal(await client.getBranchObjectId('gantry-workspace/demo/shape'), null)
  })
})

test('createBranch creates a new branch pointing at the source branch\'s current tip, and branchExists then reports it', async () => {
  await withFakeBitbucketServer(
    { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files: { 'instance.yaml': 'stage: shape\n' } },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      const mainObjectId = await client.getBranchObjectId('main')

      const result = await client.createBranch('gantry-workspace/demo/shape')
      assert.equal(result.name, 'gantry-workspace/demo/shape')
      assert.equal(result.from, 'main')
      assert.equal(result.objectId, mainObjectId)

      assert.equal(await client.branchExists('gantry-workspace/demo/shape'), true)
      // Stacked from main means it starts out carrying main's own content, no commit of its own.
      assert.equal(await client.getFileContent('instance.yaml', { branch: 'gantry-workspace/demo/shape' }), 'stage: shape\n')
    }
  )
})

test('createBranch can stack a new branch on another (non-main) branch, not just on main', async () => {
  await withFakeBitbucketServer(
    { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files: { 'instance.yaml': 'stage: shape\n' } },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      await client.createBranch('gantry-workspace/demo/shape')
      await client.writeFile('instance.yaml', 'stage: hld-define\n', { branch: 'gantry-workspace/demo/shape' })

      await client.createBranch('gantry-workspace/demo/hld-define', { from: 'gantry-workspace/demo/shape' })
      assert.equal(
        await client.getFileContent('instance.yaml', { branch: 'gantry-workspace/demo/hld-define' }),
        'stage: hld-define\n'
      )
      // main is untouched by either branch's own commits.
      assert.equal(await client.getFileContent('instance.yaml', { branch: 'main' }), 'stage: shape\n')
    }
  )
})

// The third of #41's three required normalized-error scenarios: creating a branch from a source that
// does not exist.
test('createBranch throws NotFoundError when the source branch does not exist', async () => {
  await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT }, async (baseUrl) => {
    const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
    await assert.rejects(() => client.createBranch('feature-x', { from: 'no-such-branch' }), NotFoundError)
  })
})

test('createBranch throws RequestError when the branch name already exists', async () => {
  await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT }, async (baseUrl) => {
    const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
    await client.createBranch('feature-x')
    await assert.rejects(() => client.createBranch('feature-x'), RequestError)
  })
})

test('createBranch surfaces a rejected token as AuthenticationError', async () => {
  await withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT }, async (baseUrl) => {
    const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: 'wrong-token', baseUrl })
    await assert.rejects(() => client.createBranch('feature-x'), AuthenticationError)
  })
})

test('createBranch points the new branch at the current tip of "from", and a write on the new branch never leaks back onto "from"', async () => {
  await withFakeBitbucketServer(
    { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files: { 'README.md': '# repo' } },
    async (baseUrl) => {
      const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
      await client.writeFile('main-only.md', 'main content\n')
      await client.createBranch('stacked', { from: 'main' })
      assert.equal(await client.getFileContent('main-only.md', { branch: 'stacked' }), 'main content\n')

      await client.writeFile('branch-only.md', 'branch content\n', { branch: 'stacked' })
      assert.equal(await client.fileExists('branch-only.md', 'main'), false)
    }
  )
})

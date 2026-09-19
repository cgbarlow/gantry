import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createGitHubClient,
  GitHubAuthenticationError,
  GitHubNotFoundError,
  GitHubRepoNotFoundError,
} from '../lib/githubClient.js'
import { AuthenticationError, NotFoundError } from '../lib/providerErrors.js'
import { withFakeGitHubServer, GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT } from './helpers/fakeGitHubServer.js'

// lib/githubClient.js's read-only subset: proving a PAT reaches a real repository (#8's
// getRepo/repoExists, the primitive lib/repoCheck.js's checkGitHubRepo builds on), and reading an
// existing file/folder over the Contents API (#19's getFileContent/fileExists/listFolder, the
// primitive lib/definitionGitHub.js — and so lib/libraryCache.js's GitHub-backed refresh — builds
// on). Exercised over real `fetch` against tests/helpers/fakeGitHubServer.js, never a mocked `fetch`,
// per #1's own Testing Decisions.

test('createGitHubClient requires owner, repository and pat', () => {
  assert.throws(() => createGitHubClient({ repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT }), /"owner" is required/)
  assert.throws(() => createGitHubClient({ owner: GITHUB_OWNER, pat: GITHUB_VALID_PAT }), /"repository" is required/)
  assert.throws(() => createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY }), /"pat" is required/)
  // Synchronously, not left to fail on the first request — an empty string is as absent as `undefined`.
  assert.throws(() => createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: '' }), /"pat" is required/)
})

// ---------- #8: getRepo / repoExists (checkGitHubRepo's own primitive) ----------

test('getRepo resolves the repository metadata when the PAT is accepted and the repo exists', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
    const repo = await client.getRepo()
    assert.equal(repo.name, GITHUB_REPOSITORY)
    assert.equal(repo.owner.login, GITHUB_OWNER)
  })
})

test('repoExists is true when the repo exists and the PAT is accepted', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
    assert.equal(await client.repoExists(), true)
  })
})

test('getRepo throws GitHubAuthenticationError when GitHub rejects the PAT', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: 'wrong-pat', baseUrl })
    await assert.rejects(() => client.getRepo(), GitHubAuthenticationError)
  })
})

test('getRepo throws GitHubRepoNotFoundError when the repository does not exist', async () => {
  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, repoExists: false },
    async (baseUrl) => {
      const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      await assert.rejects(() => client.getRepo(), GitHubRepoNotFoundError)
    }
  )
})

test('repoExists is false, not thrown, when the repository does not exist', async () => {
  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, repoExists: false },
    async (baseUrl) => {
      const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      assert.equal(await client.repoExists(), false)
    }
  )
})

test('getRepo tags a repo-not-found error with provider: "github"', async () => {
  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, repoExists: false },
    async (baseUrl) => {
      const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      try {
        await client.getRepo()
        assert.fail('expected getRepo to throw')
      } catch (err) {
        assert.equal(err.provider, 'github')
      }
    }
  )
})

test('a GitHub Enterprise Server-shaped baseUrl (a host + /api/v3 path) is honoured as-is', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    // The fake server has no real /api/v3 prefix of its own — this only proves the client sends
    // requests to exactly the baseUrl it was given, the same convention a real GHES host would need.
    const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
    assert.equal(client.baseUrl, baseUrl)
    await client.getRepo()
  })
})

// ---------- #19: getFileContent / fileExists / listFolder (lib/definitionGitHub.js's own primitive) ----------

test('getFileContent reads an existing file back unchanged', async () => {
  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: { 'definitions/design/1/definition.yaml': 'id: design\n' } },
    async (baseUrl) => {
      const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      const content = await client.getFileContent('definitions/design/1/definition.yaml')
      assert.equal(content, 'id: design\n')
    }
  )
})

test('getFileContent on a missing path throws the neutral NotFoundError, tagged github', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
    await assert.rejects(() => client.getFileContent('does/not/exist.yaml'), (err) => {
      assert.ok(err instanceof GitHubNotFoundError)
      assert.ok(err instanceof NotFoundError, 'also catchable as the neutral NotFoundError')
      assert.equal(err.provider, 'github')
      return true
    })
  })
})

test('getFileContent on a directory path throws NotFoundError (a directory is not a file)', async () => {
  await withFakeGitHubServer(
    { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: { 'definitions/design/1/definition.yaml': 'id: design\n' } },
    async (baseUrl) => {
      const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      await assert.rejects(() => client.getFileContent('definitions/design'), GitHubNotFoundError)
    }
  )
})

test('fileExists is true after a file is present, false for an unwritten path', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT, files: { 'exists.md': 'x\n' } }, async (baseUrl) => {
    const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
    assert.equal(await client.fileExists('exists.md'), true)
    assert.equal(await client.fileExists('does-not-exist.md'), false)
  })
})

test('listFolder lists immediate children only, sorted by path, and [] for a folder that does not exist', async () => {
  await withFakeGitHubServer(
    {
      owner: GITHUB_OWNER,
      repository: GITHUB_REPOSITORY,
      validPat: GITHUB_VALID_PAT,
      files: {
        'definitions/design/1/definition.yaml': 'id: design\n',
        'definitions/design/2/definition.yaml': 'id: design\n',
        'definitions/widget/1/definition.yaml': 'id: widget\n',
      },
    },
    async (baseUrl) => {
      const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl })
      const top = await client.listFolder('definitions')
      assert.deepEqual(top.map((e) => e.path).sort(), ['definitions/design', 'definitions/widget'])
      assert.ok(top.every((e) => e.isFolder))

      const designVersions = await client.listFolder('definitions/design')
      assert.deepEqual(designVersions.map((e) => e.path), ['definitions/design/1', 'definitions/design/2'])

      assert.deepEqual(await client.listFolder('definitions/nope'), [])
    }
  )
})

test('a rejected PAT surfaces as the neutral AuthenticationError, tagged github', async () => {
  await withFakeGitHubServer({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, validPat: GITHUB_VALID_PAT }, async (baseUrl) => {
    const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: 'wrong-pat', baseUrl })
    await assert.rejects(() => client.getFileContent('anything.md'), (err) => {
      assert.ok(err instanceof GitHubAuthenticationError)
      assert.ok(err instanceof AuthenticationError)
      assert.equal(err.provider, 'github')
      return true
    })
  })
})

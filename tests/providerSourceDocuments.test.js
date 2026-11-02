import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { loadDefinition } from '../lib/definition.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { createProviderSourceStore, findSourceReadBranch } from '../lib/providerSourceDocuments.js'
import { resolveGitHubStageBranch } from '../lib/githubStageBranch.js'
import { resolveStageBranch, stageBranchName } from '../lib/stageBranch.js'
import { MAX_SOURCE_BYTES, parseSourceManifest } from '../web/lib/sourceDocuments.js'
import { pngImage } from './helpers/sourceFixtures.js'
import { basicAuthHeader, withRunningServerForProvider, withScratchInstances } from './helpers/lifecycle.js'

// #280 (map #238, decided in #245 and #242): Source documents on Azure DevOps and GitHub workspaces. Each upload, rename, Extract text again and removal is exactly one commit on the current Stage's branch (never part of a stage Save), a later Stage's branch carries the documents of an earlier one, and a 25 MB upload goes through. The lifecycle itself is tested in tests/sourceDocuments.test.js; these cover the Provider half.

const SLUG = 'acme'
const ROOT = `gantry-workspace/${SLUG}`
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const json = (method, body, headers = {}) => ({ method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

const PROVIDERS = [
  {
    name: 'Azure DevOps',
    provider: 'azure-devops',
    serverOptions: { allowAzureDevOpsBaseUrlOverride: true },
    location: (ctx) => ({ azureDevOps: { organization: ctx.organization, project: ctx.project, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
    options: (ctx) => ({ azureDevOps: { organization: ctx.organization, project: ctx.project, repository: ctx.repository, baseUrl: ctx.providerBaseUrl, pat: ctx.pat } }),
    client: (ctx) => createAzureDevOpsClient({ organization: ctx.organization, project: ctx.project, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
    commitRequest: (method, path) => method === 'POST' && /\/pushes$/.test(path),
    // The request that moves the branch to the new commit, and the answer a Provider gives when the branch has moved on.
    movesBranch: (method, path) => method === 'POST' && /\/pushes$/.test(path),
    movedTip: { status: 409, body: { message: 'The push was rejected: the branch tip has moved' } },
    resolveBranch: resolveStageBranch,
    base: (ctx) => ({ organization: ctx.organization, project: ctx.project, repository: ctx.repository, baseUrl: ctx.providerBaseUrl, pat: ctx.pat }),
  },
  {
    name: 'GitHub',
    provider: 'github',
    serverOptions: {},
    location: (ctx) => ({ github: { owner: ctx.owner, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
    options: (ctx) => ({ github: { owner: ctx.owner, repository: ctx.repository, baseUrl: ctx.providerBaseUrl, pat: ctx.pat } }),
    client: (ctx) => createGitHubClient({ owner: ctx.owner, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
    commitRequest: (method, path) => method === 'POST' && /\/git\/commits$/.test(path),
    movesBranch: (method, path) => method === 'PATCH' && /\/git\/refs\/heads\//.test(path),
    movedTip: { status: 422, body: { message: 'Update is not a fast forward' } },
    resolveBranch: resolveGitHubStageBranch,
    base: (ctx) => ({ owner: ctx.owner, repository: ctx.repository, baseUrl: ctx.providerBaseUrl, pat: ctx.pat }),
  },
]

// Counts the commits the server asks a Provider to make while `fn` runs (the server shares this process's fetch).
async function countingCommits(commitRequest, fn) {
  const realFetch = globalThis.fetch
  let commits = 0
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (commitRequest((init?.method ?? 'GET').toUpperCase(), url.pathname)) commits++
    return realFetch(input, init)
  }
  try {
    await fn()
  } finally {
    globalThis.fetch = realFetch
  }
  return commits
}

async function withProviderInstance(spec, fn) {
  return withScratchInstances((instancesDir) =>
    withRunningServerForProvider(spec.provider, { options: { instancesDir, ...spec.serverOptions } }, async (ctx) => {
      const auth = { Authorization: basicAuthHeader(ctx.pat) }
      const created = await fetch(`${ctx.gantryBase}/api/instances`, json('POST', { definition: 'design', slug: SLUG, ...spec.location(ctx) }, auth))
      assert.equal(created.status, 201, await created.text())
      const sources = (suffix = '', init = {}) => fetch(`${ctx.gantryBase}/api/instance/sources${suffix}${suffix.includes('?') ? '&' : '?'}slug=${SLUG}`, { ...init, headers: { ...auth, ...init.headers } })
      return fn({ ctx, auth, sources, client: spec.client(ctx) })
    })
  )
}

const bytesOf = async (client, path, branch) => Buffer.from(await client.getFileBytes(path, { branch }))

for (const spec of PROVIDERS) {
  describe(`${spec.name}-backed Source documents`, () => {
    test('every upload, new text read, rename and removal is exactly one commit on the current Stage branch; main is untouched', () =>
      withProviderInstance(spec, async ({ sources, client }) => {
        const branch = stageBranchName(SLUG, 'shape')
        const original = Buffer.from([0x50, 0x4b, 3, 4, 0, 255, 254, 1, 2, 3])

        // Nothing yet: a read starts no branch.
        const empty = await (await sources()).json()
        assert.deepEqual(empty.entries, [])
        assert.equal(await client.branchExists(branch), false)

        // A refused upload starts no branch and makes no commit.
        const refused = await sources('', json('POST', { filename: 'empty.docx', dataBase64: '' }))
        assert.equal(refused.status, 400)
        assert.equal(await client.branchExists(branch), false)

        // Upload: the original, its extracted text and the manifest, one commit.
        let response
        const uploadCommits = await countingCommits(spec.commitRequest, async () => {
          response = await sources('', json('POST', { filename: 'Client brief.docx', dataBase64: b64(original), text: '# Client brief\n\nFive thousand users.\n', uploadedBy: 'a.architect' }))
        })
        assert.equal(response.status, 201, await response.clone().text())
        const { entry } = await response.json()
        assert.equal(entry.id, 'client-brief')
        assert.equal(uploadCommits, 1, 'the original, its text and the manifest are one commit')
        assert.equal(await client.branchExists(branch), true)
        assert.deepEqual(await bytesOf(client, `${ROOT}/sources/Client brief.docx`, branch), original)
        assert.equal(await client.getFileContent(`${ROOT}/sources/.text/Client brief.docx.md`, { branch }), '# Client brief\n\nFive thousand users.\n')
        assert.deepEqual(parseSourceManifest(await client.getFileContent(`${ROOT}/sources/manifest.yaml`, { branch })), [entry])
        assert.equal(await client.fileExists(`${ROOT}/sources/manifest.yaml`, 'main'), false, 'main is untouched until the Stage is approved')

        // Served back from the committed manifest and text.
        assert.deepEqual((await (await sources()).json()).entries, [entry])
        const file = await sources('/client-brief/file')
        assert.equal(file.status, 200)
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), original)
        assert.equal(await (await sources('/client-brief/text')).text(), '# Client brief\n\nFive thousand users.\n')

        // A second document is a commit of its own, and the first is still listed.
        const second = await sources('', json('POST', { filename: 'Notes.md', dataBase64: b64('meeting notes'), text: 'meeting notes' }))
        assert.equal(second.status, 201)
        assert.deepEqual((await (await sources()).json()).entries.map((e) => e.id), ['client-brief', 'notes'])

        // Rename: the manifest alone, one commit.
        let renamed
        const renameCommits = await countingCommits(spec.commitRequest, async () => {
          renamed = await sources('/client-brief', json('PATCH', { title: 'Client brief v3' }))
        })
        assert.equal(renamed.status, 200, await renamed.clone().text())
        assert.equal(renameCommits, 1)
        assert.equal((await (await sources()).json()).entries[0].title, 'Client brief v3')

        // Read visually (#292): the manifest alone, one commit; only a PDF may have it.
        await sources('', json('POST', { filename: 'Plan.pdf', dataBase64: b64('%PDF-1.4'), text: '## Page 1\n\nlabels' }))
        let visual
        const visualCommits = await countingCommits(spec.commitRequest, async () => {
          visual = await sources('/plan', json('PATCH', { readVisually: true }))
        })
        assert.equal(visual.status, 200, await visual.clone().text())
        assert.equal(visualCommits, 1)
        assert.equal((await (await sources()).json()).entries.find((e) => e.id === 'plan').readVisually, true)
        assert.equal((await sources('/client-brief', json('PATCH', { readVisually: true }))).status, 400, 'a Word file cannot be read visually')

        // Extract text again: the text and the manifest, one commit.
        let retext
        const textCommits = await countingCommits(spec.commitRequest, async () => {
          retext = await sources('/client-brief/text', json('PUT', { text: '# Client brief, read again\n' }))
        })
        assert.equal(retext.status, 200, await retext.clone().text())
        assert.equal(textCommits, 1)
        assert.equal(await client.getFileContent(`${ROOT}/sources/.text/Client brief.docx.md`, { branch }), '# Client brief, read again\n')

        // Remove: the original and its text go, the entry stays marked removed, one commit.
        let removal
        const removeCommits = await countingCommits(spec.commitRequest, async () => {
          removal = await sources('/client-brief', json('DELETE', { removedBy: 'a.architect' }))
        })
        assert.equal(removal.status, 200, await removal.clone().text())
        assert.equal(removeCommits, 1)
        assert.equal(await client.fileExists(`${ROOT}/sources/Client brief.docx`, branch), false)
        assert.equal(await client.fileExists(`${ROOT}/sources/.text/Client brief.docx.md`, branch), false)
        const after = (await (await sources()).json()).entries.find((e) => e.id === 'client-brief')
        assert.equal(after.removedBy, 'a.architect')
        assert.match(after.removedAt, /^\d{4}-/)
        assert.equal((await sources('/client-brief/file')).status, 409)
        assert.equal(await client.fileExists(`${ROOT}/sources/Notes.md`, branch), true, 'the other document is untouched')
      }))

    test('a change that is refused makes no commit and starts no branch', () =>
      withProviderInstance(spec, async ({ sources, client }) => {
        const branch = stageBranchName(SLUG, 'shape')
        const commits = await countingCommits(spec.commitRequest, async () => {
          assert.equal((await sources('/nothing', json('PATCH', { title: 'x' }))).status, 404)
          assert.equal((await sources('/nothing', json('DELETE', {}))).status, 404)
          assert.equal((await sources('', json('POST', { filename: 'big.pdf', dataBase64: b64(Buffer.alloc(MAX_SOURCE_BYTES + 1, 1)) }))).status, 413)
        })
        assert.equal(commits, 0)
        assert.equal(await client.branchExists(branch), false)
      }))

    test('a 25 MB document is accepted, committed and read back byte for byte', () =>
      withProviderInstance(spec, async ({ sources, client }) => {
        const branch = stageBranchName(SLUG, 'shape')
        const big = Buffer.alloc(MAX_SOURCE_BYTES)
        for (let i = 0; i < big.length; i += 4099) big[i] = (i / 4099) & 0xff
        const started = Date.now()
        const res = await sources('', json('POST', { filename: 'Big scan.pdf', dataBase64: b64(big), uploadedBy: 'a.architect' }))
        const took = Date.now() - started
        assert.equal(res.status, 201, (await res.clone().text()).slice(0, 300))
        assert.ok(took < 10_000, `the upload took ${took} ms against a fake Provider; a real one is held to 10 seconds`)
        assert.equal((await res.json()).entry.size, MAX_SOURCE_BYTES)
        assert.deepEqual(await bytesOf(client, `${ROOT}/sources/Big scan.pdf`, branch), big)
        const back = await sources('/big-scan/file')
        assert.equal(back.status, 200)
        assert.equal(back.headers.get('content-type'), 'application/pdf')
        assert.deepEqual(Buffer.from(await back.arrayBuffer()), big)
        const remove = await sources('/big-scan', json('DELETE', {}))
        assert.equal(remove.status, 200)
        assert.equal(await client.fileExists(`${ROOT}/sources/Big scan.pdf`, branch), false)
      }))

    test("a later Stage's branch carries the documents uploaded on an earlier Stage's branch, and a read before it starts sees them", () =>
      withProviderInstance(spec, async ({ ctx, sources, client }) => {
        const definition = loadDefinition('design', { version: 3 })
        const [first, second] = definition.stages
        const firstBranch = stageBranchName(SLUG, first.id)
        const secondBranch = stageBranchName(SLUG, second.id)

        await sources('', json('POST', { filename: 'Requirements.md', dataBase64: b64('must be fast'), text: 'must be fast' }))
        assert.equal(await client.branchExists(firstBranch), true)
        assert.equal(await client.branchExists(secondBranch), false)

        // Before the later Stage has a branch, its reads come from the earlier one's.
        const options = spec.options(ctx)
        assert.equal(await findSourceReadBranch(options, definition, SLUG, second.id), firstBranch)
        assert.equal(await findSourceReadBranch(options, definition, SLUG, first.id), firstBranch)

        // Once the later Stage's branch is cut, it is stacked on the earlier one and carries the document.
        const base = spec.base(ctx)
        await spec.resolveBranch(base, definition, SLUG, second.id)
        assert.equal(await client.fileExists(`${ROOT}/sources/Requirements.md`, secondBranch), true)
        const store = createProviderSourceStore(options, SLUG, {
          readBranch: await findSourceReadBranch(options, definition, SLUG, second.id),
          resolveWriteBranch: () => spec.resolveBranch(base, definition, SLUG, second.id),
        })
        assert.deepEqual((await store.list()).entries.map((e) => e.id), ['requirements'])
        assert.equal(await store.readText('requirements'), 'must be fast')

        // A document added on the later Stage lands on its branch only.
        await store.upload({ filename: 'Risks.md', bytes: new Uint8Array(Buffer.from('lock-in')), text: 'lock-in' })
        assert.equal(await client.fileExists(`${ROOT}/sources/Risks.md`, secondBranch), true)
        assert.equal(await client.fileExists(`${ROOT}/sources/Risks.md`, firstBranch), false)
      }))

    test('a commit refused because someone else moved the branch first is run again from the new tip, so neither change is lost', () =>
      withProviderInstance(spec, async ({ sources, client }) => {
        const branch = stageBranchName(SLUG, 'shape')
        await sources('', json('POST', { filename: 'First.md', dataBase64: b64('one'), text: 'one' }))

        const realFetch = globalThis.fetch
        let refused = 0
        let colleague = null
        const interfering = async (input, init) => {
          const url = new URL(typeof input === 'string' ? input : input.url)
          if (refused === 0 && spec.movesBranch((init?.method ?? 'GET').toUpperCase(), url.pathname)) {
            refused++
            // A colleague's commit lands first (their own write is not interfered with), then this one is refused.
            globalThis.fetch = realFetch
            const manifest = await client.getFileContent(`${ROOT}/sources/manifest.yaml`, { branch })
            colleague = await client.writeFile(`${ROOT}/sources/other.txt`, manifest, { branch, message: 'A colleague got in first' })
            globalThis.fetch = interfering
            return new Response(JSON.stringify(spec.movedTip.body), { status: spec.movedTip.status, headers: { 'Content-Type': 'application/json' } })
          }
          return realFetch(input, init)
        }
        globalThis.fetch = interfering
        let res
        try {
          res = await sources('', json('POST', { filename: 'Second.md', dataBase64: b64('two'), text: 'two' }))
        } finally {
          globalThis.fetch = realFetch
        }
        assert.equal(refused, 1)
        assert.ok(colleague)
        assert.equal(res.status, 201, await res.clone().text())
        assert.deepEqual((await (await sources()).json()).entries.map((e) => e.id), ['first', 'second'])
        assert.equal(await client.fileExists(`${ROOT}/sources/Second.md`, branch), true)
        assert.equal(await client.fileExists(`${ROOT}/sources/other.txt`, branch), true, "the colleague's commit is still there")
      }))

    test('Use as image (#281) copies a picture into assets/ as one commit and keeps no link to the document', () =>
      withProviderInstance(spec, async ({ sources, client }) => {
        const branch = stageBranchName(SLUG, 'shape')
        const png = Buffer.from(pngImage())
        for (const [filename, data] of [['Whiteboard sketch.png', png], ['Notes.txt', Buffer.from('notes')]]) {
          const up = await sources('', json('POST', { filename, dataBase64: b64(data), uploadedBy: 'a.architect' }))
          assert.equal(up.status, 201, await up.clone().text())
        }

        // Not a picture: refused, and nothing is committed.
        const refused = await countingCommits(spec.commitRequest, async () => {
          const res = await sources('/notes/as-asset', json('POST', {}))
          assert.equal(res.status, 400)
          assert.match((await res.json()).error, /Only a PNG or JPEG can be used as an image/)
        })
        assert.equal(refused, 0)

        let body
        const commits = await countingCommits(spec.commitRequest, async () => {
          const res = await sources('/whiteboard-sketch/as-asset', json('POST', { uploadedBy: 'a.architect' }))
          assert.equal(res.status, 201, await res.clone().text())
          body = await res.json()
        })
        assert.equal(commits, 1, 'the copy is one commit')
        assert.equal(body.asset.filename, 'Whiteboard-sketch.png')
        assert.equal(body.reference, '![Whiteboard sketch](assets/Whiteboard-sketch.png)')
        assert.deepEqual(await bytesOf(client, `${ROOT}/assets/Whiteboard-sketch.png`, branch), png)

        // Used again: a new file, never the first overwritten.
        const again = await (await sources('/whiteboard-sketch/as-asset', json('POST', {}))).json()
        assert.equal(again.asset.filename, 'Whiteboard-sketch-2.png')

        // Removing the document leaves the image alone.
        const removed = await sources('/whiteboard-sketch', json('DELETE', {}))
        assert.equal(removed.status, 200)
        assert.equal(await client.fileExists(`${ROOT}/sources/Whiteboard sketch.png`, branch), false)
        assert.deepEqual(await bytesOf(client, `${ROOT}/assets/Whiteboard-sketch.png`, branch), png)
      }))

    test('a Provider workspace answers a read with the Instance as it stands on main when no Stage has begun', () =>
      withProviderInstance(spec, async ({ ctx }) => {
        const definition = loadDefinition('design', { version: 3 })
        assert.equal(await findSourceReadBranch(spec.options(ctx), definition, SLUG, definition.stages[0].id), undefined)
      }))
  })
}

// GitLab (and Atlassian) take Source documents when their module Save lands: until then the routes say so rather than half-working.
test('a GitLab-backed Instance is told Source documents are not available there yet', () =>
  withScratchInstances((instancesDir) =>
    withRunningServerForProvider(
      'gitlab',
      { options: { instancesDir }, fakeServerOptions: { files: { [`/${ROOT}/instance.yaml`]: `definition: design\ndefinitionVersion: 3\nslug: ${SLUG}\nstage: shape\nassignee: ""\n` } } },
      async (ctx) => {
        registerInstance(SLUG, { kind: 'gitlab', namespace: ctx.namespace, repository: ctx.repository, baseUrl: ctx.providerBaseUrl }, { instancesDir })
        registerWorkspace({ provider: 'gitlab', location: { namespace: ctx.namespace, repository: ctx.repository, baseUrl: ctx.providerBaseUrl }, owner: '' }, { instancesDir })
        const res = await fetch(`${ctx.gantryBase}/api/instance/sources?slug=${SLUG}`, { headers: { Authorization: basicAuthHeader(ctx.pat) } })
        assert.equal(res.status, 400)
        assert.match((await res.json()).error, /GitLab and Atlassian workspaces take them when their module Save lands/)
      }
    )
  ))

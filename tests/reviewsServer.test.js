import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { createGitLabClient } from '../lib/gitlabClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { stageBranchName } from '../lib/stageBranch.js'
import { StorageConflictError } from '../lib/storage.js'
import { prepareReviewedCopies, readReviewManifest, storeReviewedCopies } from '../lib/reviews.js'
import { loadDefinition } from '../lib/definition.js'
import { REVIEWED_COPY_MAX_BYTES } from '../web/lib/reviewedCopy.js'
import { parseReviewManifest } from '../web/lib/reviewManifest.js'
import { RENDER_PROPERTIES, reviewedCopy } from './helpers/reviewedCopyFixture.js'
import { basicAuthHeader, withRunningServer, withRunningServerForProvider, withScratchInstances } from './helpers/lifecycle.js'
import { createInMemoryStorage } from './helpers/inMemoryStorage.js'

// #302 (ADR-0066): bringing a Reviewed copy into an Instance. An upload is checked with the browser's own
// reader, kept under the Instance's `reviews/` folder with `reviews/manifest.yaml`, as one commit on the
// current Stage's branch for a Provider-hosted Instance and one write for a server workspace.

const SLUG = 'acme'
const props = (overrides = {}) => ({ ...RENDER_PROPERTIES, instance: SLUG, ...overrides })
const b64 = (bytes) => Buffer.from(bytes).toString('base64')
const post = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
const upload = (files, headers) => post({ files: files.map(([filename, bytes]) => ({ filename, dataBase64: b64(bytes) })) }, headers)
const okCopy = (overrides) => reviewedCopy({ properties: props(overrides) })

// ---------- A server workspace ----------

async function withServer(fn) {
  return withScratchInstances((instancesDir) =>
    withRunningServer({ instancesDir }, async (base) => {
      const created = await fetch(`${base}/api/instances`, post({ definition: 'design', slug: SLUG }))
      assert.equal(created.status, 201, await created.clone().text())
      return fn({ base, instancesDir, folder: join(instancesDir, 'default', SLUG) })
    })
  )
}

describe('a server workspace', () => {
  test('keeps an accepted copy under reviews/ with a manifest, and serves the list and the file back', () =>
    withServer(async ({ base, folder }) => {
      assert.deepEqual(await (await fetch(`${base}/api/instance/reviews?slug=${SLUG}`)).json(), { reviews: [] })
      const bytes = okCopy()
      const res = await fetch(`${base}/api/instance/reviews?slug=${SLUG}`, upload([['HLD - Ana and Ben.docx', bytes]]))
      assert.equal(res.status, 201, await res.clone().text())
      const { reviews } = await res.json()
      assert.equal(reviews.length, 1)
      const [entry] = reviews
      assert.match(entry.id, /^[0-9a-f-]{36}$/)
      assert.deepEqual(
        { ...entry, id: undefined, date: undefined },
        {
          id: undefined,
          file: `reviews/${entry.id}.docx`,
          name: 'HLD - Ana and Ben.docx',
          artefact: 'hld',
          stage: 'shape',
          renderId: RENDER_PROPERTIES['render-id'],
          commit: RENDER_PROPERTIES.commit,
          commenters: ['Ana Reviewer', 'Ben Commenter'],
          date: undefined,
          comments: 9,
          commentsAnswered: 0,
          size: bytes.length,
        }
      )
      assert.ok(Math.abs(Date.now() - Date.parse(entry.date)) < 60_000)

      assert.deepEqual(readFileSync(join(folder, entry.file)), bytes)
      assert.deepEqual(parseReviewManifest(readFileSync(join(folder, 'reviews', 'manifest.yaml'), 'utf8')), [entry])
      assert.deepEqual((await (await fetch(`${base}/api/instance/reviews?slug=${SLUG}`)).json()).reviews, [entry])

      const file = await fetch(`${base}/api/instance/reviews/${entry.id}/file?slug=${SLUG}`)
      assert.equal(file.status, 200)
      assert.match(file.headers.get('content-disposition'), /HLD - Ana and Ben\.docx/)
      assert.deepEqual(Buffer.from(await file.arrayBuffer()), bytes)
      assert.equal((await fetch(`${base}/api/instance/reviews/00000000-0000-0000-0000-000000000000/file?slug=${SLUG}`)).status, 404)
      assert.equal((await fetch(`${base}/api/instance/reviews/..%2Finstance.yaml/file?slug=${SLUG}`)).status, 404)
    }))

  test('several copies of the same render come in together and are all listed, with the manifest written once', () =>
    withServer(async ({ base, folder }) => {
      const res = await fetch(`${base}/api/instance/reviews?slug=${SLUG}`, upload([['a.docx', okCopy()], ['b.docx', okCopy()]]))
      assert.equal(res.status, 201)
      const { reviews } = await res.json()
      assert.equal(reviews.length, 2)
      assert.notEqual(reviews[0].id, reviews[1].id)
      assert.equal(reviews[0].renderId, reviews[1].renderId)
      assert.deepEqual(readdirSync(join(folder, 'reviews')).sort(), [`${reviews[0].id}.docx`, `${reviews[1].id}.docx`, 'manifest.yaml'].sort())
      // A later upload adds to the list rather than replacing it.
      await fetch(`${base}/api/instance/reviews?slug=${SLUG}`, upload([['c.docx', okCopy()]]))
      assert.equal((await (await fetch(`${base}/api/instance/reviews?slug=${SLUG}`)).json()).reviews.length, 3)
    }))

  test('refuses a document with no gantry-* properties, telling the architect to upload it as a Source document, and keeps nothing', () =>
    withServer(async ({ base, folder }) => {
      const res = await fetch(`${base}/api/instance/reviews?slug=${SLUG}`, upload([['plain.docx', reviewedCopy({ properties: {} })]]))
      assert.equal(res.status, 422)
      const body = await res.json()
      assert.match(body.error, /Upload it as a Source document instead/)
      assert.deepEqual(body.files.map((f) => [f.filename, f.ok, f.code]), [['plain.docx', false, 'untagged']])
      assert.equal(existsSync(join(folder, 'reviews')), false)
    }))

  test('refuses one from another Instance, naming where it came from; one bad document keeps the whole upload out', () =>
    withServer(async ({ base, folder }) => {
      const res = await fetch(`${base}/api/instance/reviews?slug=${SLUG}`, upload([['good.docx', okCopy()], ['other.docx', okCopy({ instance: 'globex', stage: 'build' })]]))
      assert.equal(res.status, 422)
      const body = await res.json()
      assert.match(body.files[1].message, /Instance "globex", Artefact "hld", Stage "build"/)
      assert.deepEqual(body.files.map((f) => f.ok), [true, false])
      assert.equal(existsSync(join(folder, 'reviews')), false, 'one upload is all or nothing')
    }))

  test('refuses one from an Artefact the Instance has no such thing as, and a file that is not Word', () =>
    withServer(async ({ base }) => {
      const artefact = await fetch(`${base}/api/instance/reviews?slug=${SLUG}`, upload([['x.docx', okCopy({ artefact: 'offer-pack' })]]))
      assert.equal(artefact.status, 422)
      assert.match((await artefact.json()).error, /no Artefact "offer-pack"/)
      const text = await fetch(`${base}/api/instance/reviews?slug=${SLUG}`, upload([['notes.docx', Buffer.from('not a zip at all')]]))
      assert.equal(text.status, 422)
      assert.match((await text.json()).error, /not a Word/)
      assert.equal((await fetch(`${base}/api/instance/reviews?slug=${SLUG}`, post({ files: [] }))).status, 400)
      assert.equal((await fetch(`${base}/api/instance/reviews?slug=${SLUG}`, post({ nothing: true }))).status, 400)
    }))

  test('an upload over 25 MB is refused', () =>
    withServer(async ({ base, folder }) => {
      const big = Buffer.alloc(REVIEWED_COPY_MAX_BYTES + 1024, 7)
      const res = await fetch(`${base}/api/instance/reviews?slug=${SLUG}`, upload([['big.docx', big]]))
      assert.equal(res.status, 413)
      assert.equal(existsSync(join(folder, 'reviews')), false)
    }))

  test('the basis is every Field of the Definition with its wording today, or the Fields alone', () =>
    withServer(async ({ base }) => {
      const basis = await (await fetch(`${base}/api/instance/review-basis?slug=${SLUG}`)).json()
      assert.equal(basis.basis, 'today')
      assert.ok(basis.fields.length > 50)
      assert.deepEqual(Object.keys(basis.fields[0]).sort(), ['fieldId', 'fieldTitle', 'moduleId', 'moduleTitle', 'text'])
      const bare = await (await fetch(`${base}/api/instance/review-basis?slug=${SLUG}&texts=0`)).json()
      assert.equal('text' in bare.fields[0], false)
      assert.equal((await fetch(`${base}/api/instance/review-basis?slug=${SLUG}&commit=nonsense%21`)).status, 400)
      // A server workspace has no history, so a commit asked for still gives today's content.
      assert.equal((await (await fetch(`${base}/api/instance/review-basis?slug=${SLUG}&commit=abc1234`)).json()).basis, 'today')
    }))
})

// ---------- Any store ----------

describe('a server workspace kept in any store', () => {
  test('writes the copies and the manifest through the storage layer, and a manifest changed meanwhile is not lost', async () => {
    const storage = createInMemoryStorage()
    const definition = loadDefinition('design', { version: 3 })
    const options = { storage, instancesDir: 'instances/default' }
    const prepared = await prepareReviewedCopies([{ filename: 'one.docx', bytes: okCopy() }], { slug: SLUG, definition })
    assert.equal(prepared.ok, true)
    await storeReviewedCopies(SLUG, prepared.copies, options)
    const second = await prepareReviewedCopies([{ filename: 'two.docx', bytes: okCopy() }], { slug: SLUG, definition })
    await storeReviewedCopies(SLUG, second.copies, options)
    const entries = await readReviewManifest(SLUG, options)
    assert.deepEqual(entries.map((e) => e.name), ['one.docx', 'two.docx'])
    const stored = (await storage.list('instances/default/acme/reviews/')).map((f) => f.path)
    assert.equal(stored.length, 3)

    // Two uploads at once: the loser of the conditional write reads the manifest again.
    const racing = createInMemoryStorage()
    let conflicts = 0
    const putText = racing.putText.bind(racing)
    racing.putText = async (path, text, opts) => {
      if (path.endsWith('manifest.yaml') && conflicts === 0 && opts?.ifVersion === null) {
        conflicts++
        await putText(path, 'x: y\n')
        throw new StorageConflictError(path, 'it already exists')
      }
      return putText(path, text, opts)
    }
    await storeReviewedCopies(SLUG, prepared.copies, { storage: racing, instancesDir: 'instances/default' })
    assert.equal(conflicts, 1)
    assert.equal((await readReviewManifest(SLUG, { storage: racing, instancesDir: 'instances/default' })).length, 1)
  })
})

// ---------- Every Provider: one commit on the Stage's branch ----------

const PROVIDERS = [
  {
    name: 'Azure DevOps',
    provider: 'azure-devops',
    serverOptions: { allowAzureDevOpsBaseUrlOverride: true },
    location: (ctx) => ({ azureDevOps: { organization: ctx.organization, project: ctx.project, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
    client: (ctx) => createAzureDevOpsClient({ organization: ctx.organization, project: ctx.project, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
    commitRequest: (method, path) => method === 'POST' && /\/pushes$/.test(path),
    bytesOf: async (client, path, branch) => Buffer.from(await client.getFileContent(path, { branch }), 'base64'),
  },
  {
    name: 'GitHub',
    provider: 'github',
    serverOptions: {},
    location: (ctx) => ({ github: { owner: ctx.owner, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }),
    client: (ctx) => createGitHubClient({ owner: ctx.owner, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
    commitRequest: (method, path) => method === 'POST' && /\/git\/commits$/.test(path),
    bytesOf: async (client, path, branch) => Buffer.from(await client.getFileBytes(path, { branch })),
  },
  {
    // POST /api/instances doesn't create on GitLab, so the instance is seeded and registered.
    name: 'GitLab',
    provider: 'gitlab',
    serverOptions: {},
    fakeServerOptions: () => ({ files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\ndefinitionVersion: 3\nslug: ${SLUG}\nstage: shape\nassignee: ""\n` } }),
    register: (ctx, instancesDir) => {
      registerInstance(SLUG, { kind: 'gitlab', namespace: ctx.namespace, repository: ctx.repository, baseUrl: ctx.providerBaseUrl }, { instancesDir })
      registerWorkspace({ provider: 'gitlab', location: { namespace: ctx.namespace, repository: ctx.repository, baseUrl: ctx.providerBaseUrl }, owner: '' }, { instancesDir })
    },
    client: (ctx) => createGitLabClient({ namespace: ctx.namespace, repository: ctx.repository, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
    commitRequest: (method, path) => method === 'POST' && /\/repository\/commits$/.test(path),
    bytesOf: async (client, path, branch) => Buffer.from(await client.getFileBytes(path, { branch })),
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

for (const { name, provider, serverOptions, location, fakeServerOptions, register, client: clientFor, commitRequest, bytesOf } of PROVIDERS) {
  test(`${name}-backed: an upload is one commit on the current Stage's branch, holding the copies and the manifest; main is untouched`, () =>
    withScratchInstances((instancesDir) =>
      withRunningServerForProvider(provider, { options: { instancesDir, ...serverOptions }, fakeServerOptions: fakeServerOptions?.() }, async (ctx) => {
        const auth = { Authorization: basicAuthHeader(ctx.pat) }
        if (register) register(ctx, instancesDir)
        else {
          const created = await fetch(`${ctx.gantryBase}/api/instances`, post({ definition: 'design', slug: SLUG, ...location(ctx) }, auth))
          assert.equal(created.status, 201, await created.text())
        }
        const client = clientFor(ctx)
        const branch = stageBranchName(SLUG, 'shape')
        const root = `gantry-workspace/${SLUG}`

        // Nothing yet: a read starts no branch.
        assert.deepEqual(await (await fetch(`${ctx.gantryBase}/api/instance/reviews?slug=${SLUG}`, { headers: auth })).json(), { reviews: [] })
        assert.equal(await client.branchExists(branch), false)

        // A refused upload starts no branch either.
        const refused = await fetch(`${ctx.gantryBase}/api/instance/reviews?slug=${SLUG}`, upload([['plain.docx', reviewedCopy({ properties: {} })]], auth))
        assert.equal(refused.status, 422)
        assert.equal(await client.branchExists(branch), false)

        const first = okCopy()
        const second = okCopy()
        let response
        const commits = await countingCommits(commitRequest, async () => {
          response = await fetch(`${ctx.gantryBase}/api/instance/reviews?slug=${SLUG}`, upload([['one.docx', first], ['two.docx', second]], auth))
        })
        assert.equal(response.status, 201, await response.clone().text())
        const { reviews } = await response.json()
        assert.equal(reviews.length, 2)
        assert.equal(commits, 1, 'both copies and the manifest are one commit')

        assert.deepEqual(parseReviewManifest(await client.getFileContent(`${root}/reviews/manifest.yaml`, { branch })), reviews)
        assert.deepEqual(await bytesOf(client, `${root}/${reviews[0].file}`, branch), first)
        assert.deepEqual(await bytesOf(client, `${root}/${reviews[1].file}`, branch), second)
        assert.equal(await client.fileExists(`${root}/reviews/manifest.yaml`, 'main'), false, 'main is untouched until the stage is approved')

        // Served back from the branch.
        assert.deepEqual((await (await fetch(`${ctx.gantryBase}/api/instance/reviews?slug=${SLUG}`, { headers: auth })).json()).reviews, reviews)
        const file = await fetch(`${ctx.gantryBase}/api/instance/reviews/${reviews[1].id}/file?slug=${SLUG}`, { headers: auth })
        assert.deepEqual(Buffer.from(await file.arrayBuffer()), second)

        // A later upload adds to the manifest in a commit of its own.
        const third = okCopy()
        const later = await fetch(`${ctx.gantryBase}/api/instance/reviews?slug=${SLUG}`, upload([['three.docx', third]], auth))
        assert.equal(later.status, 201)
        const listed = (await (await fetch(`${ctx.gantryBase}/api/instance/reviews?slug=${SLUG}`, { headers: auth })).json()).reviews
        assert.deepEqual(listed.map((r) => r.name), ['one.docx', 'two.docx', 'three.docx'])
        assert.equal(parseYAML(await client.getFileContent(`${root}/instance.yaml`, { branch })).slug, SLUG)
      })
    ))
}

// GitLab's fake provider keeps no history to read a file at (the real GitLab does, and the code is the same shape).
for (const { name, provider, serverOptions, location, fakeServerOptions, register, client: clientFor } of PROVIDERS.filter((p) => p.provider !== 'gitlab')) {
  test(`${name}-backed: the basis for placing comments by text is each Field as it was at the render's commit, not as it is now`, () =>
    withScratchInstances((instancesDir) =>
      withRunningServerForProvider(provider, { options: { instancesDir, ...serverOptions }, fakeServerOptions: fakeServerOptions?.() }, async (ctx) => {
        const auth = { Authorization: basicAuthHeader(ctx.pat) }
        if (register) register(ctx, instancesDir)
        else {
          const created = await fetch(`${ctx.gantryBase}/api/instances`, post({ definition: 'design', slug: SLUG, ...location(ctx) }, auth))
          assert.equal(created.status, 201, await created.text())
        }
        const client = clientFor(ctx)
        const path = `gantry-workspace/${SLUG}/modules/background.md`
        const moduleText = (problem) => `---\nmodule: background\nstatus: draft\nowner: ""\n---\n\n# Background and context\n\n## Problem statement\n\n${problem}\n`
        const rendered = await client.writeFile(path, moduleText('We need a new payments platform.'), { message: 'The content the document was rendered from' })
        const commit = rendered.push.commits[0].commitId
        await client.writeFile(path, moduleText('We have since decided to buy a payments platform.'), { message: 'Edited after the render' })

        const problemOf = (basis) => basis.fields.find((f) => f.moduleId === 'background' && f.fieldId === 'problem')
        const atCommit = await (await fetch(`${ctx.gantryBase}/api/instance/review-basis?slug=${SLUG}&commit=${commit}`, { headers: auth })).json()
        assert.equal(atCommit.basis, 'commit', JSON.stringify(atCommit).slice(0, 300))
        assert.equal(atCommit.commit, commit)
        assert.equal(problemOf(atCommit).text, 'We need a new payments platform.')
        const today = await (await fetch(`${ctx.gantryBase}/api/instance/review-basis?slug=${SLUG}`, { headers: auth })).json()
        assert.equal(today.basis, 'today')
        assert.equal(problemOf(today).text, 'We have since decided to buy a payments platform.')
        const bare = await (await fetch(`${ctx.gantryBase}/api/instance/review-basis?slug=${SLUG}&commit=${commit}&texts=0`, { headers: auth })).json()
        assert.equal(problemOf(bare).text, undefined)
      })
    ))
}

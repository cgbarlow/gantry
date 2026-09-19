import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitHubClient } from '../lib/githubClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { renderArtefact } from '../lib/render.js'
import { exampleModuleText } from './helpers/fixtureModules.js'
import {
  withRunningServerForProvider,
  withScratchInstances,
  basicAuthHeader,
  GITHUB_OWNER,
  GITHUB_REPOSITORY,
  GITHUB_VALID_PAT,
} from './helpers/lifecycle.js'

// #16 — GitHub assets, file URLs and render provenance. Mirrors the equivalent Azure DevOps coverage
// in tests/serverAzureDevOpsAssets.test.js (listing, file streaming, render embedding) plus the
// Document-Control/commit-footer coverage in tests/serverAzureDevOpsAuth.test.js's render tests —
// exercised against a real fake GitHub server, the primary seam per #1's Testing Decisions. Simpler
// than the Azure DevOps suite throughout: GitHub stage branches (#12) don't exist yet, so every
// read/write here is against `main` directly — no branch/main union-fetch, no stale-branch fallback.

const ONE_PX_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function withScratchGitHubServer(fn, { fakeServerOptions } = {}) {
  return withScratchInstances((instancesDir) =>
    withRunningServerForProvider('github', { options: { instancesDir }, fakeServerOptions }, (ctx) => fn({ ...ctx, instancesDir }))
  )
}

function seedFiles(slug, { withImageRef = false } = {}) {
  const background = withImageRef
    ? exampleModuleText('background').replace('## Problem statement', '## Problem statement\n\n![My Img](assets/foo.png)')
    : exampleModuleText('background')
  return {
    [`/gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: shape\n`,
    [`/gantry-workspace/${slug}/modules/background.md`]: background,
    [`/gantry-workspace/${slug}/modules/introduction.md`]: exampleModuleText('introduction'),
    [`/gantry-workspace/${slug}/modules/solution-definition.md`]: exampleModuleText('solution-definition'),
    [`/gantry-workspace/${slug}/modules/team-and-estimates.md`]: exampleModuleText('team-and-estimates'),
    // #16: seeded as real bytes (a Buffer), matching what a written binary file ends up as in the
    // fake's own store (tests/helpers/fakeGitHubServer.js) — not the base64 text of those bytes.
    [`/gantry-workspace/${slug}/assets/foo.png`]: Buffer.from(ONE_PX_PNG_BASE64, 'base64'),
  }
}

function registerGitHubInstance(slug, { instancesDir, providerBaseUrl }) {
  registerInstance(slug, { kind: 'github', owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl }, { instancesDir })
  registerWorkspace({ provider: 'github', location: { owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: providerBaseUrl }, owner: '' }, { instancesDir })
}

// ---------- GET /api/instance/assets ----------

test('GET /api/instance/assets lists a GitHub-backed instance\'s committed repo assets', async () => {
  const slug = 'github-assets-list'
  await withScratchGitHubServer(
    async (ctx) => {
      registerGitHubInstance(slug, ctx)
      const res = await fetch(`${ctx.gantryBase}/api/instance/assets?slug=${slug}`, {
        headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      })
      assert.equal(res.status, 200)
      const list = await res.json()
      const entry = list.find((a) => a.filename === 'foo.png')
      assert.ok(entry, 'expected foo.png in the listing')
      assert.equal(entry.id, 'foo.png')

      const noAuthRes = await fetch(`${ctx.gantryBase}/api/instance/assets?slug=${slug}`)
      assert.equal(noAuthRes.status, 401)
      assert.match((await noAuthRes.json()).message ?? '', /GitHub/)
    },
    { fakeServerOptions: { files: seedFiles(slug) } }
  )
})

test('GET /api/instance/assets/:filename/file streams a GitHub-backed instance\'s image with the right Content-Type', async () => {
  const slug = 'github-assets-file'
  const pngBytes = Buffer.from(ONE_PX_PNG_BASE64, 'base64')
  await withScratchGitHubServer(
    async (ctx) => {
      registerGitHubInstance(slug, ctx)
      const res = await fetch(`${ctx.gantryBase}/api/instance/assets/foo.png/file?slug=${slug}`, {
        headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'image/png')
      const bytes = Buffer.from(await res.arrayBuffer())
      assert.deepEqual(bytes, pngBytes)

      const missingRes = await fetch(`${ctx.gantryBase}/api/instance/assets/missing.png/file?slug=${slug}`, {
        headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      })
      assert.equal(missingRes.status, 404)

      const badRes = await fetch(`${ctx.gantryBase}/api/instance/assets/bad%2Fname.png/file?slug=${slug}`, {
        headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      })
      assert.equal(badRes.status, 400)
    },
    { fakeServerOptions: { files: seedFiles(slug) } }
  )
})

// ---------- POST /api/instance/assets (upload — GitHub, unlike Azure DevOps, supports this) ----------

test('POST /api/instance/assets uploads a real file to the GitHub repo, unlike the blocked Azure DevOps route', async () => {
  const slug = 'github-assets-upload'
  await withScratchGitHubServer(
    async (ctx) => {
      registerGitHubInstance(slug, ctx)
      const res = await fetch(`${ctx.gantryBase}/api/instance/assets?slug=${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
        body: JSON.stringify({ filename: 'diagram.png', dataBase64: ONE_PX_PNG_BASE64, name: 'Diagram' }),
      })
      assert.equal(res.status, 201)
      const body = await res.json()
      assert.equal(body.id, 'diagram.png')
      assert.equal(body.filename, 'diagram.png')
      assert.equal(body.name, 'Diagram')

      // Verified directly against the fake GitHub repo, not just gantry's own idea of what it wrote.
      const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: ctx.providerBaseUrl })
      const bytes = await client.getFileBytes(`gantry-workspace/${slug}/assets/diagram.png`)
      assert.equal(bytes.toString('base64'), ONE_PX_PNG_BASE64)

      const listRes = await fetch(`${ctx.gantryBase}/api/instance/assets?slug=${slug}`, {
        headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      })
      const list = await listRes.json()
      assert.ok(list.find((a) => a.filename === 'diagram.png'))
    },
    { fakeServerOptions: { files: seedFiles(slug) } }
  )
})

test('POST /api/instance/assets rejects an unsupported file type and a missing file, writing nothing', async () => {
  const slug = 'github-assets-upload-invalid'
  await withScratchGitHubServer(
    async (ctx) => {
      registerGitHubInstance(slug, ctx)
      const auth = basicAuthHeader(GITHUB_VALID_PAT)

      const badExtRes = await fetch(`${ctx.gantryBase}/api/instance/assets?slug=${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ filename: 'notes.txt', dataBase64: 'aGVsbG8=' }),
      })
      assert.equal(badExtRes.status, 400)
      assert.match((await badExtRes.json()).error, /Unsupported image file type/)

      const missingBytesRes = await fetch(`${ctx.gantryBase}/api/instance/assets?slug=${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ filename: 'blank.png' }),
      })
      assert.equal(missingBytesRes.status, 400)
      assert.match((await missingBytesRes.json()).error, /image file is required/)

      const traversalRes = await fetch(`${ctx.gantryBase}/api/instance/assets?slug=${slug}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ filename: '../evil.png', dataBase64: ONE_PX_PNG_BASE64 }),
      })
      assert.equal(traversalRes.status, 400)

      const listRes = await fetch(`${ctx.gantryBase}/api/instance/assets?slug=${slug}`, { headers: { Authorization: auth } })
      const list = await listRes.json()
      assert.equal(list.length, 1, 'only the pre-seeded foo.png should exist — nothing invalid was written')
    },
    { fakeServerOptions: { files: seedFiles(slug) } }
  )
})

// ---------- Render: embedding, source citation, and commit-footer provenance ----------

test('POST /api/instance/render/:artefact against a GitHub-backed instance renders a real docx embedding the repo asset, and pushes it back to the same repo', async () => {
  const slug = 'github-render-embed'
  await withScratchGitHubServer(
    async (ctx) => {
      registerGitHubInstance(slug, ctx)
      const res = await fetch(`${ctx.gantryBase}/api/instance/render/soap?slug=${slug}`, {
        method: 'POST',
        headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.artefact, 'soap')
      assert.equal(body.githubPath, `gantry-workspace/${slug}/out/Github Render Embed - Solution on a Page.docx`)
      // The citation/artefact URL honours the location's own baseUrl (here, the fake server standing
      // in for a real host or a GitHub Enterprise Server one) rather than assuming public github.com —
      // see tests/githubFileUrl.test.js for the public-vs-enterprise base-URL derivation itself.
      const url = new URL(body.githubUrl)
      assert.equal(url.origin, ctx.providerBaseUrl)
      assert.equal(decodeURIComponent(url.pathname), `/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/blob/main/${body.githubPath}`)

      const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: ctx.providerBaseUrl })
      const pushedBytes = await client.getFileBytes(body.githubPath)
      assert.equal(pushedBytes.subarray(0, 2).toString(), 'PK', 'expected a real docx (zip) at the pushed path')

      // Write the pushed bytes to a scratch file to inspect its embedded media.
      const scratchDir = mkdtempSync(join(tmpdir(), 'gantry-github-render-'))
      const scratchDocx = join(scratchDir, 'rendered.docx')
      try {
        writeFileSync(scratchDocx, pushedBytes)
        const mediaListing = execFileSync('unzip', ['-l', scratchDocx], { encoding: 'utf8' })
        assert.match(mediaListing, /word\/media\//, 'expected the repo asset embedded as media')
        const pngBytes = Buffer.from(ONE_PX_PNG_BASE64, 'base64')
        const mediaFiles = mediaListing
          .split('\n')
          .map((l) => l.trim().split(/\s+/).pop())
          .filter((n) => n && /^word\/media\//.test(n))
        let found = false
        for (const mf of mediaFiles) {
          if (Buffer.from(execFileSync('unzip', ['-p', scratchDocx, mf])).equals(pngBytes)) found = true
        }
        assert.ok(found, 'expected the foo.png bytes embedded in the rendered docx')
      } finally {
        rmSync(scratchDir, { recursive: true, force: true })
      }
    },
    { fakeServerOptions: { files: seedFiles(slug, { withImageRef: true }) } }
  )
})

test('rendering as markdown carries a source citation linking to the committed file on GitHub, and a Document Control naming the pushed commit', async () => {
  const slug = 'github-render-citation'
  await withScratchGitHubServer(
    async (ctx) => {
      registerGitHubInstance(slug, ctx)
      const res = await fetch(`${ctx.gantryBase}/api/instance/render/soap?slug=${slug}&format=md`, {
        method: 'POST',
        headers: { Authorization: basicAuthHeader(GITHUB_VALID_PAT) },
      })
      assert.equal(res.status, 200)
      const body = await res.json()
      assert.equal(body.format, 'md')

      const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: ctx.providerBaseUrl })
      const markdown = await client.getFileContent(body.githubPath)

      // Source citation: links to the committed asset's own file on GitHub (via the fake server's
      // own baseUrl, standing in for a real host/GitHub Enterprise Server host).
      const citationMatch = markdown.match(/\*Source: \[assets\/foo\.png\]\(<([^>]+)>\)\*/)
      assert.ok(citationMatch, 'expected a "Source: [assets/foo.png](<url>)" citation in the rendered markdown')
      assert.equal(citationMatch[1], `${ctx.providerBaseUrl}/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/blob/main/gantry-workspace/${slug}/assets/foo.png`)

      // Document Control: names the commit this render was pushed as, linking to that commit on GitHub.
      assert.match(markdown, /## Document Control/)
      const commitCellMatch = markdown.match(/\| Commit \| \[`([^`]+)`\]\(([^)]+)\) \|/)
      assert.ok(commitCellMatch, 'expected a Commit row naming a real commit hash, hyperlinked')
      const [, shortHash, commitHref] = commitCellMatch
      assert.ok(shortHash, 'expected a non-empty commit hash')
      // The link targets the *full* commit sha (a short hash alone wouldn't reliably resolve as a
      // GitHub URL); the short hash is only ever the visible link text, same convention as the
      // Azure DevOps Document Control partial.
      assert.ok(
        commitHref.startsWith(`${ctx.providerBaseUrl}/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/commit/`),
        `expected a GitHub commit URL, got ${commitHref}`
      )
      assert.ok(commitHref.endsWith(shortHash) || commitHref.includes(shortHash), 'expected the href to reference the same commit as the visible short hash')
    },
    { fakeServerOptions: { files: seedFiles(slug, { withImageRef: true }) } }
  )
})

test('rendering the same artefact against a GitHub-backed instance twice overwrites the previous render rather than accumulating files', async () => {
  const slug = 'github-render-overwrite'
  await withScratchGitHubServer(
    async (ctx) => {
      registerGitHubInstance(slug, ctx)
      const auth = basicAuthHeader(GITHUB_VALID_PAT)
      const first = await fetch(`${ctx.gantryBase}/api/instance/render/soap?slug=${slug}`, { method: 'POST', headers: { Authorization: auth } })
      assert.equal(first.status, 200)
      const second = await fetch(`${ctx.gantryBase}/api/instance/render/soap?slug=${slug}`, { method: 'POST', headers: { Authorization: auth } })
      assert.equal(second.status, 200)
      const secondBody = await second.json()

      const client = createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: GITHUB_VALID_PAT, baseUrl: ctx.providerBaseUrl })
      const items = await client.listFolder(`gantry-workspace/${slug}/out`)
      const docxFiles = items.filter((i) => !i.isFolder && i.path.endsWith('.docx'))
      assert.equal(docxFiles.length, 1, 'expected exactly one rendered docx, not one per render')
      assert.equal(docxFiles[0].path, secondBody.githubPath)
    },
    { fakeServerOptions: { files: seedFiles(slug) } }
  )
})

test('POST /api/instance/render/:artefact against a GitHub-backed instance with no PAT returns the structured "authentication required" response naming github', async () => {
  const slug = 'github-render-noauth'
  await withScratchGitHubServer(
    async (ctx) => {
      registerGitHubInstance(slug, ctx)
      const res = await fetch(`${ctx.gantryBase}/api/instance/render/soap?slug=${slug}`, { method: 'POST' })
      assert.equal(res.status, 401)
      const body = await res.json()
      assert.equal(body.error, 'authentication_required')
      assert.match(body.message, /GitHub/)
    },
    { fakeServerOptions: { files: seedFiles(slug) } }
  )
})

// ---------- Direct lib/render.js unit coverage (empty assets folder, and a Node-side check the CLI/library caller also exercises) ----------

test('renderArtefact against a GitHub-backed instance with an empty assets folder still renders, without embedding stray media', async () => {
  const slug = 'github-render-empty-assets'
  await withScratchInstances(async (instancesDir) => {
    const { withFakeGitHubServer, GITHUB_OWNER: owner, GITHUB_REPOSITORY: repository, GITHUB_VALID_PAT: pat } = await import('./helpers/fakeGitHubServer.js')
    const files = {
      [`/gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: shape\n`,
      [`/gantry-workspace/${slug}/modules/background.md`]: exampleModuleText('background'),
      [`/gantry-workspace/${slug}/modules/introduction.md`]: exampleModuleText('introduction'),
      [`/gantry-workspace/${slug}/modules/solution-definition.md`]: exampleModuleText('solution-definition'),
      [`/gantry-workspace/${slug}/modules/team-and-estimates.md`]: exampleModuleText('team-and-estimates'),
      // no assets folder at all
    }
    await withFakeGitHubServer({ owner, repository, validPat: pat, files }, async (providerBaseUrl) => {
      const github = { owner, repository, pat, baseUrl: providerBaseUrl }
      const result = await renderArtefact(slug, 'soap', { github, instancesDir, definitionsDir: 'definitions' })
      const mediaListing = execFileSync('unzip', ['-l', result.docxPath], { encoding: 'utf8' })
      assert.match(mediaListing, /word\/document\.xml/)
    })
  })
})

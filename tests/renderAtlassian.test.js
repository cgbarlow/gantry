import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBitbucketClient } from '../lib/bitbucketClient.js'
import { renderArtefact } from '../lib/render.js'
import { exampleModuleText } from './helpers/fixtureModules.js'
import { withScratchInstances } from './helpers/lifecycle.js'
import { withFakeBitbucketServer, BITBUCKET_OWNER, BITBUCKET_REPOSITORY, BITBUCKET_VALID_PAT } from './helpers/fakeBitbucketServer.js'

// #43 — Atlassian (Bitbucket-backed) assets, file URLs and render provenance. Mirrors the equivalent
// GitLab coverage in tests/serverGitLabAssetsAndRender.test.js (asset embedding, source citation,
// commit-footer provenance, overwrite-not-accumulate, empty-assets-folder), exercised directly against
// a real fake Bitbucket Cloud server rather than through HTTP: an Atlassian workspace's own location
// schema (ADR-0042) carries no `baseUrl` field at all (Bitbucket Cloud's API host is always
// `api.bitbucket.org` in production), so there is no way for a registered workspace to point a real
// `gantry serve` HTTP route at a fake server the way the GitHub/GitLab suites' own `baseUrl`-in-location
// convention allows — wiring `lib/server.js`'s own HTTP routes for an Atlassian workspace (and the
// registry support that needs) is left to the ticket that actually adds that route surface. This suite
// instead exercises `lib/render.js`'s exported functions directly, passing `{ atlassian: { owner,
// repository, pat, baseUrl } }` the same way a caller who *has* already resolved a workspace's Bitbucket
// credential would.

const ONE_PX_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function atlassianLocation(baseUrl, overrides = {}) {
  return { owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl, ...overrides }
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
    // Seeded as real bytes (a Buffer), matching what a written binary file ends up as in the fake's own
    // store (tests/helpers/fakeBitbucketServer.js) — not the base64 text of those bytes.
    [`/gantry-workspace/${slug}/assets/foo.png`]: Buffer.from(ONE_PX_PNG_BASE64, 'base64'),
  }
}

function withScratchBitbucketRender(slug, files, fn) {
  return withScratchInstances((instancesDir) =>
    withFakeBitbucketServer({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, validPat: BITBUCKET_VALID_PAT, files }, (baseUrl) =>
      fn({ instancesDir, baseUrl, atlassian: atlassianLocation(baseUrl) })
    )
  )
}

test('renderArtefact against an Atlassian-backed instance renders a real docx embedding the repo asset, and pushes it back to the same repo', async () => {
  const slug = 'atlassian-render-embed'
  await withScratchBitbucketRender(slug, seedFiles(slug, { withImageRef: true }), async ({ instancesDir, baseUrl, atlassian }) => {
    const result = await renderArtefact(slug, 'soap', { atlassian, instancesDir, definitionsDir: 'definitions' })
    assert.equal(result.atlassianPath, `gantry-workspace/${slug}/out/Atlassian Render Embed - Solution on a Page.docx`)

    const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
    const pushedBytes = await client.getFileBytes(result.atlassianPath)
    assert.equal(pushedBytes.subarray(0, 2).toString(), 'PK', 'expected a real docx (zip) at the pushed path')

    // Write the pushed bytes to a scratch file to inspect its embedded media.
    const scratchDir = mkdtempSync(join(tmpdir(), 'gantry-atlassian-render-'))
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
  })
})

test('rendering as markdown carries a source citation linking to the committed file on Bitbucket, and a Document Control naming the pushed commit', async () => {
  const slug = 'atlassian-render-citation'
  await withScratchBitbucketRender(slug, seedFiles(slug, { withImageRef: true }), async ({ instancesDir, baseUrl, atlassian }) => {
    const result = await renderArtefact(slug, 'soap', { atlassian, instancesDir, definitionsDir: 'definitions', format: 'md' })
    assert.equal(result.format, 'md')

    const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
    const markdown = await client.getFileContent(result.atlassianPath)

    // Source citation: links to the committed asset's own file on Bitbucket Cloud's real web host
    // (lib/atlassianFileUrl.js — always bitbucket.org, ADR-0042: Cloud-only, no self-hosted baseUrl).
    const citationMatch = markdown.match(/\*Source: \[assets\/foo\.png\]\(<([^>]+)>\)\*/)
    assert.ok(citationMatch, 'expected a "Source: [assets/foo.png](<url>)" citation in the rendered markdown')
    assert.equal(
      citationMatch[1],
      `https://bitbucket.org/${BITBUCKET_OWNER}/${BITBUCKET_REPOSITORY}/src/main/gantry-workspace/${slug}/assets/foo.png`
    )

    // Document Control: names the commit this render was pushed as, linking to that commit on Bitbucket.
    assert.match(markdown, /## Document Control/)
    const commitCellMatch = markdown.match(/\| Commit \| \[`([^`]+)`\]\(([^)]+)\) \|/)
    assert.ok(commitCellMatch, 'expected a Commit row naming a real commit hash, hyperlinked')
    const [, shortHash, commitHref] = commitCellMatch
    assert.ok(shortHash, 'expected a non-empty commit hash')
    assert.ok(
      commitHref.startsWith(`https://bitbucket.org/${BITBUCKET_OWNER}/${BITBUCKET_REPOSITORY}/commits/`),
      `expected a Bitbucket commit URL, got ${commitHref}`
    )
    assert.ok(commitHref.endsWith(shortHash) || commitHref.includes(shortHash), 'expected the href to reference the same commit as the visible short hash')
  })
})

test('rendering the same artefact against an Atlassian-backed instance twice overwrites the previous render rather than accumulating files', async () => {
  const slug = 'atlassian-render-overwrite'
  await withScratchBitbucketRender(slug, seedFiles(slug), async ({ instancesDir, baseUrl, atlassian }) => {
    const first = await renderArtefact(slug, 'soap', { atlassian, instancesDir, definitionsDir: 'definitions' })
    const second = await renderArtefact(slug, 'soap', { atlassian, instancesDir, definitionsDir: 'definitions' })

    const client = createBitbucketClient({ owner: BITBUCKET_OWNER, repository: BITBUCKET_REPOSITORY, pat: BITBUCKET_VALID_PAT, baseUrl })
    const items = await client.listFolder(`gantry-workspace/${slug}/out`)
    const docxFiles = items.filter((i) => !i.isFolder && i.path.endsWith('.docx'))
    assert.equal(docxFiles.length, 1, 'expected exactly one rendered docx, not one per render')
    assert.equal(docxFiles[0].path, second.atlassianPath)
    assert.equal(first.atlassianPath, second.atlassianPath)
  })
})

test('renderArtefact against an Atlassian-backed instance with an empty assets folder still renders, without embedding stray media', async () => {
  const slug = 'atlassian-render-empty-assets'
  const files = {
    [`/gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: shape\n`,
    [`/gantry-workspace/${slug}/modules/background.md`]: exampleModuleText('background'),
    [`/gantry-workspace/${slug}/modules/introduction.md`]: exampleModuleText('introduction'),
    [`/gantry-workspace/${slug}/modules/solution-definition.md`]: exampleModuleText('solution-definition'),
    [`/gantry-workspace/${slug}/modules/team-and-estimates.md`]: exampleModuleText('team-and-estimates'),
    // no assets folder at all
  }
  await withScratchBitbucketRender(slug, files, async ({ instancesDir, atlassian }) => {
    const result = await renderArtefact(slug, 'soap', { atlassian, instancesDir, definitionsDir: 'definitions' })
    const mediaListing = execFileSync('unzip', ['-l', result.docxPath], { encoding: 'utf8' })
    assert.match(mediaListing, /word\/document\.xml/)
  })
})

test('renderArtefact against an Atlassian-backed instance with no PAT surfaces a BitbucketAuthenticationError naming atlassian', async () => {
  const slug = 'atlassian-render-noauth'
  await withScratchBitbucketRender(slug, seedFiles(slug), async ({ instancesDir, baseUrl }) => {
    const badAtlassian = atlassianLocation(baseUrl, { pat: 'wrong-pat' })
    await assert.rejects(
      () => renderArtefact(slug, 'soap', { atlassian: badAtlassian, instancesDir, definitionsDir: 'definitions' }),
      (err) => {
        assert.equal(err.name, 'BitbucketAuthenticationError')
        assert.equal(err.provider, 'atlassian')
        return true
      }
    )
  })
})

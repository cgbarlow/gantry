import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from '../lib/server.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { registerWorkspace } from '../lib/workspaceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { renderArtefact } from '../lib/render.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

const ONE_PX_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'

function basicAuthHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
}

function withRunningServer(options, fn) {
  return new Promise((resolve, reject) => {
    const server = createServer(options)
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn(`http://localhost:${port}`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

// WI260 repo-as-asset-store: workspace-backed instance whose repo has gantry-workspace/<slug>/assets/foo.png — GET lists it; GET file streams it with image Content-Type; and a module that references ../assets/foo.png renders a .docx that embeds the image.
test('workspace-backed repo assets: listing, file streaming, and render embedding', async () => {
  const pngBytes = Buffer.from(ONE_PX_PNG_BASE64, 'base64')
  const ctxWithImage = exampleModuleText('background').replace(
    '## Problem statement',
    '## Problem statement\n\n![My Img](../assets/foo.png)'
  )
  const files = {
    '/gantry-workspace/repo-assets-test/instance.yaml': 'definition: design\nslug: repo-assets-test\nstage: shape\n',
    '/gantry-workspace/repo-assets-test/modules/background.md': ctxWithImage,
    '/gantry-workspace/repo-assets-test/modules/introduction.md': exampleModuleText('introduction'),
    '/gantry-workspace/repo-assets-test/modules/solution-definition.md': exampleModuleText('solution-definition'),
    '/gantry-workspace/repo-assets-test/modules/team-and-estimates.md': exampleModuleText('team-and-estimates'),
    '/gantry-workspace/repo-assets-test/assets/foo.png': ONE_PX_PNG_BASE64,
  }

  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files },
    async (baseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        registerInstance(
          'repo-assets-test',
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl },
          { instancesDir }
        )
        registerWorkspace(
          { location: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl }, owner: '' },
          { instancesDir }
        )

        // Server API checks
        await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          const auth = basicAuthHeader(VALID_PAT)
          const listRes = await fetch(`${base}/api/instance/assets?slug=repo-assets-test`, {
            headers: { Authorization: auth },
          })
          assert.equal(listRes.status, 200)
          const list = await listRes.json()
          const entry = list.find((a) => a.filename === 'foo.png')
          assert.ok(entry, 'expected foo.png in listing')
          assert.equal(entry.id, 'foo.png')

          const fileRes = await fetch(`${base}/api/instance/assets/foo.png/file?slug=repo-assets-test`, {
            headers: { Authorization: auth },
          })
          assert.equal(fileRes.status, 200)
          assert.equal(fileRes.headers.get('content-type'), 'image/png')
          const bytes = Buffer.from(await fileRes.arrayBuffer())
          assert.deepEqual(bytes, pngBytes)

          // Without PAT should be 401
          const noAuthRes = await fetch(`${base}/api/instance/assets?slug=repo-assets-test`)
          assert.equal(noAuthRes.status, 401)
        })

        // Render embedding check
        const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
        const result = await renderArtefact('repo-assets-test', 'soap', {
          azureDevOps,
          instancesDir,
          definitionsDir: 'definitions',
        })
        const mediaListing = execFileSync('unzip', ['-l', result.docxPath], { encoding: 'utf8' })
        assert.match(mediaListing, /word\/media\//, 'expected embedded media in docx')
        const mediaFiles = mediaListing
          .split('\n')
          .map((l) => l.trim().split(/\s+/).pop())
          .filter((n) => n && /^word\/media\//.test(n))
        let found = false
        for (const mf of mediaFiles) {
          const bytes = execFileSync('unzip', ['-p', result.docxPath, mf])
          if (bytes.equals(pngBytes)) found = true
        }
        assert.ok(found, 'expected png bytes embedded in docx word/media')
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})

test('workspace-backed repo assets: assets/foo.png variant also embeds', async () => {
  const pngBytes = Buffer.from(ONE_PX_PNG_BASE64, 'base64')
  const ctxWithImage = exampleModuleText('background').replace(
    '## Problem statement',
    '## Problem statement\n\n![My Img](assets/foo.png)'
  )
  const files = {
    '/gantry-workspace/repo-assets-test2/instance.yaml': 'definition: design\nslug: repo-assets-test2\nstage: shape\n',
    '/gantry-workspace/repo-assets-test2/modules/background.md': ctxWithImage,
    '/gantry-workspace/repo-assets-test2/modules/introduction.md': exampleModuleText('introduction'),
    '/gantry-workspace/repo-assets-test2/modules/solution-definition.md': exampleModuleText('solution-definition'),
    '/gantry-workspace/repo-assets-test2/modules/team-and-estimates.md': exampleModuleText('team-and-estimates'),
    '/gantry-workspace/repo-assets-test2/assets/foo.png': ONE_PX_PNG_BASE64,
  }

  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files },
    async (baseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        registerInstance(
          'repo-assets-test2',
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl },
          { instancesDir }
        )
        const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
        const result = await renderArtefact('repo-assets-test2', 'soap', {
          azureDevOps,
          instancesDir,
          definitionsDir: 'definitions',
        })
        const mediaListing = execFileSync('unzip', ['-l', result.docxPath], { encoding: 'utf8' })
        assert.match(mediaListing, /word\/media\//)
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})

test('workspace-backed repo assets: empty assets folder still renders without media', async () => {
  const files = {
    '/gantry-workspace/empty-assets-test/instance.yaml': 'definition: design\nslug: empty-assets-test\nstage: shape\n',
    '/gantry-workspace/empty-assets-test/modules/background.md': exampleModuleText('background'),
    '/gantry-workspace/empty-assets-test/modules/introduction.md': exampleModuleText('introduction'),
    '/gantry-workspace/empty-assets-test/modules/solution-definition.md': exampleModuleText('solution-definition'),
    '/gantry-workspace/empty-assets-test/modules/team-and-estimates.md': exampleModuleText('team-and-estimates'),
    // no assets folder at all
  }
  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files },
    async (baseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        registerInstance(
          'empty-assets-test',
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl },
          { instancesDir }
        )
        await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          const auth = basicAuthHeader(VALID_PAT)
          const listRes = await fetch(`${base}/api/instance/assets?slug=empty-assets-test`, {
            headers: { Authorization: auth },
          })
          assert.equal(listRes.status, 200)
          const list = await listRes.json()
          assert.deepEqual(list, [])
        })
        const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl }
        const result = await renderArtefact('empty-assets-test', 'soap', {
          azureDevOps,
          instancesDir,
          definitionsDir: 'definitions',
        })
        // Should still produce docx, just without extra media
        const mediaListing = execFileSync('unzip', ['-l', result.docxPath], { encoding: 'utf8' })
        assert.match(mediaListing, /word\/document\.xml/)
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})

// Direct unit tests for the new string-rewrite helpers (covers lib/assets.js + web/lib/assetRefs.js branches)
test('resolveRepoAsset helpers rewrite both ../assets/ and assets/ forms', async () => {
  const { resolveRepoAssetFileRefs } = await import('../lib/assets.js')
  const { resolveRepoAssetRefs } = await import('../web/lib/assetRefs.js')
  const md = 'a ![alt](../assets/foo.png) b ![b](assets/bar.jpg) c ![c](asset:123)'
  const fileRewritten = resolveRepoAssetFileRefs(md, 'slug-x', { instancesDir: '/tmp/instances' })
  // Should rewrite the two repo-asset forms to absolute paths, leaving asset:<id> untouched
  assert.match(fileRewritten, /\/tmp\/instances\/slug-x\/assets\/foo\.png/)
  assert.match(fileRewritten, /\/tmp\/instances\/slug-x\/assets\/bar\.jpg/)
  assert.match(fileRewritten, /asset:123/)

  const urlRewritten = resolveRepoAssetRefs(md, (f) => `/api/instance/assets/${f}/file?slug=slug-x`)
  assert.match(urlRewritten, /\/api\/instance\/assets\/foo\.png\/file\?slug=slug-x/)
  assert.match(urlRewritten, /\/api\/instance\/assets\/bar\.jpg\/file\?slug=slug-x/)
  assert.match(urlRewritten, /asset:123/)
})

// POST block and file 404 / fallback branches for workspace-backed
test('workspace-backed assets API: POST blocked, file 404, file fallback to main, listing union with stage branch', async () => {
  const branchSlug = 'repo-assets-branch-test'
  const branchName = `gantry-workspace/${branchSlug}/shape`
  const ctx = exampleModuleText('background')
  const files = {
    // instance on main
    [`/gantry-workspace/${branchSlug}/instance.yaml`]: `definition: design\nslug: ${branchSlug}\nstage: shape\n`,
    [`/gantry-workspace/${branchSlug}/modules/background.md`]: ctx,
    [`/gantry-workspace/${branchSlug}/modules/introduction.md`]: exampleModuleText('introduction'),
    [`/gantry-workspace/${branchSlug}/modules/solution-definition.md`]: exampleModuleText('solution-definition'),
    [`/gantry-workspace/${branchSlug}/modules/team-and-estimates.md`]: exampleModuleText('team-and-estimates'),
    // asset only on main, not on stage branch
    [`/gantry-workspace/${branchSlug}/assets/from-main.png`]: ONE_PX_PNG_BASE64,
  }
  const branchFiles = {
    [branchName]: {
      [`/gantry-workspace/${branchSlug}/instance.yaml`]: `definition: design\nslug: ${branchSlug}\nstage: shape\n`,
      [`/gantry-workspace/${branchSlug}/modules/background.md`]: ctx,
      // branch-only asset
      [`/gantry-workspace/${branchSlug}/assets/from-branch.png`]: ONE_PX_PNG_BASE64,
    },
  }

  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files, branchFiles },
    async (baseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        registerInstance(
          branchSlug,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl },
          { instancesDir }
        )
        registerWorkspace(
          { location: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl }, owner: '' },
          { instancesDir }
        )

        await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          const auth = basicAuthHeader(VALID_PAT)

          // POST should be blocked for workspace-backed
          const postRes = await fetch(`${base}/api/instance/assets?slug=${branchSlug}`, {
            method: 'POST',
            headers: { Authorization: auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              filename: 'x.png',
              dataBase64: ONE_PX_PNG_BASE64,
              source: 'https://example.com/x',
            }),
          })
          assert.equal(postRes.status, 400)
          const postBody = await postRes.json()
          assert.match(postBody.error, /not supported|commit files/i)

          // Listing should union both branches (instance's current stage is shape, branch exists, so main+branch)
          const listRes = await fetch(`${base}/api/instance/assets?slug=${branchSlug}`, {
            headers: { Authorization: auth },
          })
          assert.equal(listRes.status, 200)
          const list = await listRes.json()
          assert.ok(list.find((a) => a.filename === 'from-main.png'), 'main asset should appear')
          assert.ok(list.find((a) => a.filename === 'from-branch.png'), 'branch asset should appear')

          // File exists on main only — requested via stage-branch context should fallback to main
          const fileFromMainRes = await fetch(`${base}/api/instance/assets/from-main.png/file?slug=${branchSlug}`, {
            headers: { Authorization: auth },
          })
          assert.equal(fileFromMainRes.status, 200)
          assert.equal(fileFromMainRes.headers.get('content-type'), 'image/png')

          // File that does not exist anywhere should 404
          const missingRes = await fetch(`${base}/api/instance/assets/missing.png/file?slug=${branchSlug}`, {
            headers: { Authorization: auth },
          })
          assert.equal(missingRes.status, 404)

          // Invalid filename with slash should 400
          const badRes = await fetch(`${base}/api/instance/assets/bad%2Fname.png/file?slug=${branchSlug}`, {
            headers: { Authorization: auth },
          })
          assert.equal(badRes.status, 400)
        })

        // Render from stage branch where asset lives only on main — fallback should embed via union fetch
        const ctxWithMainAsset = exampleModuleText('background').replace(
          '## Problem statement',
          '## Problem statement\n\n![Img](../assets/from-main.png)'
        )
        // Overwrite the branch's context module to reference the main-only asset (simulate user referencing main asset from stage branch)
        // We need to push that change to the branch via the fake server's API: easiest is to seed branchFiles with updated context plus asset on main already
        // Instead, do a render that will fetch both branches; the file is on main, branch has context without change, but we can test render via direct azureDevOps with branch param
        const pngBytes = Buffer.from(ONE_PX_PNG_BASE64, 'base64')
        // Use a fresh slug where main has asset and branch has context referencing it
        const fallbackSlug = 'repo-assets-fallback-render'
        const fallbackFiles = {
          [`/gantry-workspace/${fallbackSlug}/instance.yaml`]: `definition: design\nslug: ${fallbackSlug}\nstage: shape\n`,
          [`/gantry-workspace/${fallbackSlug}/assets/fallback.png`]: ONE_PX_PNG_BASE64,
        }
        const fallbackBranchFiles = {
          [`gantry-workspace/${fallbackSlug}/shape`]: {
            [`/gantry-workspace/${fallbackSlug}/instance.yaml`]: `definition: design\nslug: ${fallbackSlug}\nstage: shape\n`,
            [`/gantry-workspace/${fallbackSlug}/modules/background.md`]: exampleModuleText('background').replace(
              '## Problem statement',
              '## Problem statement\n\n![Fall](../assets/fallback.png)'
            ),
            [`/gantry-workspace/${fallbackSlug}/modules/introduction.md`]: exampleModuleText('introduction'),
            [`/gantry-workspace/${fallbackSlug}/modules/solution-definition.md`]: exampleModuleText('solution-definition'),
            [`/gantry-workspace/${fallbackSlug}/modules/team-and-estimates.md`]: exampleModuleText('team-and-estimates'),
          },
        }
        await withFakeAzureDevOpsServer(
          { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: fallbackFiles, branchFiles: fallbackBranchFiles },
          async (baseUrl2) => {
            const instancesDir2 = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
            try {
              registerInstance(
                fallbackSlug,
                { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: baseUrl2 },
                { instancesDir: instancesDir2 }
              )
              const azureDevOps = {
                organization: ORGANIZATION,
                project: PROJECT,
                repository: REPOSITORY,
                pat: VALID_PAT,
                baseUrl: baseUrl2,
                branch: `gantry-workspace/${fallbackSlug}/shape`,
              }
              const result = await renderArtefact(fallbackSlug, 'soap', {
                azureDevOps,
                instancesDir: instancesDir2,
                definitionsDir: 'definitions',
              })
              const mediaListing = execFileSync('unzip', ['-l', result.docxPath], { encoding: 'utf8' })
              assert.match(mediaListing, /word\/media\//)
              // Confirm --resource-path branch exercised: file was fetched from main despite rendering from branch
              const mediaFiles = mediaListing
                .split('\n')
                .map((l) => l.trim().split(/\s+/).pop())
                .filter((n) => n && /^word\/media\//.test(n))
              let found = false
              for (const mf of mediaFiles) {
                const bytes = execFileSync('unzip', ['-p', result.docxPath, mf])
                if (bytes.equals(pngBytes)) found = true
              }
              assert.ok(found, 'fallback png should be embedded via main-branch fetch')
            } finally {
              rmSync(instancesDir2, { recursive: true, force: true })
            }
          }
        )
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})

// WI264: an instance advanced to a later stage (hld-define) still has a stale leftover branch
// for the completed `shape` stage. The merged shape PR put figure-1.png on `main`; the stale
// `shape` branch never got it (carries an older copy plus a shape-only asset main never had).
// Free-browsing the completed stage must read content AND assets from `main`, never the stale
// branch — while browsing the *current* stage still resolves that stage's own (legit) branch.
test('WI264: completed-stage free-browse reads assets + content from main, not the stale stage branch', async () => {
  const slug = 'repo-assets-completed-stage'
  const pngBytes = Buffer.from(ONE_PX_PNG_BASE64, 'base64')
  // A visibly different byte set standing in for the stale branch's older copy of the same file.
  const STALE_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8BQz0AEYBxVSF8FAGDeAe0Zb6zAAAAAElFTkSuQmCC'
  const staleBytes = Buffer.from(STALE_PNG_BASE64, 'base64')

  const ctx = exampleModuleText('background')
  const contextWith = (marker) => ctx.replace('## Problem statement', `## Problem statement\n\n${marker}`)

  const files = {
    // instance.yaml on main has ALREADY advanced to hld-define — `shape` is a completed stage
    [`/gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: hld-define\n`,
    [`/gantry-workspace/${slug}/modules/background.md`]: contextWith('MARKER_FROM_MAIN'),
    // figure-1.png committed on main, as it would be after the shape PR merged
    [`/gantry-workspace/${slug}/assets/figure-1.png`]: ONE_PX_PNG_BASE64,
  }

  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files },
    async (baseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        registerInstance(
          slug,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl },
          { instancesDir }
        )
        registerWorkspace(
          { location: { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl }, owner: '' },
          { instancesDir }
        )

        const client = createAzureDevOpsClient({
          organization: ORGANIZATION,
          project: PROJECT,
          repository: REPOSITORY,
          pat: VALID_PAT,
          baseUrl,
        })

        // Stale leftover branch for the completed `shape` stage: an OLD copy of figure-1.png and a
        // shape-only asset that main never had; plus stale module content.
        const shapeBranch = `gantry-workspace/${slug}/shape`
        await client.createBranch(shapeBranch)
        await client.writeFile(`/gantry-workspace/${slug}/assets/figure-1.png`, STALE_PNG_BASE64, { branch: shapeBranch })
        await client.writeFile(`/gantry-workspace/${slug}/assets/stale-only.png`, STALE_PNG_BASE64, { branch: shapeBranch })
        await client.writeFile(
          `/gantry-workspace/${slug}/modules/background.md`,
          contextWith('MARKER_FROM_STALE_SHAPE_BRANCH'),
          { branch: shapeBranch }
        )

        // Legit branch for the CURRENT stage (hld-define) with an asset that lives only there.
        const hldBranch = `gantry-workspace/${slug}/hld-define`
        await client.createBranch(hldBranch)
        await client.writeFile(`/gantry-workspace/${slug}/assets/hld-only.png`, ONE_PX_PNG_BASE64, { branch: hldBranch })

        await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          const auth = basicAuthHeader(VALID_PAT)

          // --- Completed stage (shape): assets resolve from main, not the stale branch ---
          const listRes = await fetch(`${base}/api/instance/assets?slug=${slug}&stage=shape`, {
            headers: { Authorization: auth },
          })
          assert.equal(listRes.status, 200)
          const list = await listRes.json()
          assert.ok(
            list.find((a) => a.filename === 'figure-1.png'),
            'figure-1.png (from main) should be listed for the completed stage'
          )
          assert.ok(
            !list.find((a) => a.filename === 'stale-only.png'),
            'the stale shape-branch-only asset must NOT leak into the completed-stage listing'
          )

          const fileRes = await fetch(`${base}/api/instance/assets/figure-1.png/file?slug=${slug}&stage=shape`, {
            headers: { Authorization: auth },
          })
          assert.equal(fileRes.status, 200)
          assert.equal(fileRes.headers.get('content-type'), 'image/png')
          const bytes = Buffer.from(await fileRes.arrayBuffer())
          assert.deepEqual(bytes, pngBytes, "completed-stage asset bytes must be main's copy")
          assert.notDeepEqual(bytes, staleBytes, 'completed-stage asset must not be served from the stale branch')

          // --- Completed stage (shape): module content also comes from main ---
          const instRes = await fetch(`${base}/api/instance?slug=${slug}&stage=shape`, {
            headers: { Authorization: auth },
          })
          assert.equal(instRes.status, 200)
          const inst = await instRes.json()
          assert.equal(inst.stage.id, 'shape')
          const instBlob = JSON.stringify(inst)
          assert.ok(instBlob.includes('MARKER_FROM_MAIN'), 'completed-stage module content should come from main')
          assert.ok(
            !instBlob.includes('MARKER_FROM_STALE_SHAPE_BRANCH'),
            'stale shape-branch module content must not be served for the completed stage'
          )

          // --- Current stage (hld-define): its own (legit) branch still resolves ---
          const currentFileRes = await fetch(
            `${base}/api/instance/assets/hld-only.png/file?slug=${slug}&stage=hld-define`,
            { headers: { Authorization: auth } }
          )
          assert.equal(
            currentFileRes.status,
            200,
            'current-stage asset must resolve from the current stage branch, not be forced to main'
          )
          assert.equal(currentFileRes.headers.get('content-type'), 'image/png')

          const currentListRes = await fetch(`${base}/api/instance/assets?slug=${slug}&stage=hld-define`, {
            headers: { Authorization: auth },
          })
          assert.equal(currentListRes.status, 200)
          const currentList = await currentListRes.json()
          assert.ok(
            currentList.find((a) => a.filename === 'hld-only.png'),
            'the current stage branch asset should be listed when browsing the current stage'
          )
        })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})

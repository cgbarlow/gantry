import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { createServer } from '../lib/server.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

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

// WI260: for a workspace-backed instance whose repo has gantry-workspace/<slug>/assets/foo.png
// and a module referencing ../assets/foo.png, the module-editor preview renders an <img> with naturalWidth >0
test('workspace-backed repo asset renders in preview (WI #260)', async () => {
  const ctxWithImage = readFileSync('instances/examples/modules/context.md', 'utf8').replace(
    '## Problem statement',
    '## Problem statement\n\n![Preview Img](../assets/foo.png)'
  )

  const files = {
    '/gantry-workspace/preview-asset-test/instance.yaml': 'definition: design\nslug: preview-asset-test\nstage: shape\n',
    '/gantry-workspace/preview-asset-test/modules/context.md': ctxWithImage,
    '/gantry-workspace/preview-asset-test/modules/solution-definition.md': readFileSync(
      'instances/examples/modules/solution-definition.md',
      'utf8'
    ),
    '/gantry-workspace/preview-asset-test/modules/team-and-estimates.md': readFileSync(
      'instances/examples/modules/team-and-estimates.md',
      'utf8'
    ),
    '/gantry-workspace/preview-asset-test/assets/foo.png': ONE_PX_PNG_BASE64,
  }

  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files },
    async (baseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        registerInstance(
          'preview-asset-test',
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl },
          { instancesDir }
        )

        await withRunningServer(
          { instancesDir, allowAzureDevOpsBaseUrlOverride: true },
          async (gantryBase) => {
            const browser = await launchBrowser()
            try {
              const page = await browser.newPage()
              page.setDefaultTimeout(DEFAULT_TIMEOUT)

              // Global PAT so apiFetch attaches it; extra headers so <img> tag loads too
              await page.addInitScript((pat) => {
                localStorage.setItem('gantry:ado-pat', pat)
              }, VALID_PAT)
              await page.setExtraHTTPHeaders({ Authorization: basicAuthHeader(VALID_PAT) })

              await page.goto(`${gantryBase}/instance/preview-asset-test`)
              await page.waitForSelector('.module', { timeout: 10_000 })
              // Wait for preview pane to render the markdown with image
              const previewImg = page.locator('.preview img').first()
              await previewImg.waitFor({ timeout: 10_000 })
              // naturalWidth >0 means image loaded, not broken
              const naturalWidth = await previewImg.evaluate((el) => el.naturalWidth)
              assert.ok(naturalWidth > 0, `expected naturalWidth >0, got ${naturalWidth}`)
              const src = await previewImg.getAttribute('src')
              assert.ok(src && src.includes('/api/instance/assets/foo.png/file'), `expected src to be file endpoint, got ${src}`)
            } finally {
              await browser.close()
            }
          }
        )
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})

// WI264: an instance advanced to hld-define, free-browsing the completed `shape` stage. The merged
// shape PR left figure-1.png on `main`; the stale `gantry-workspace/<slug>/shape` branch carries a
// BROKEN copy. Switching the stage switcher to the completed stage must still show a working preview
// <img> (server forces the read to main), and its src must carry `stage=shape`.
test('workspace-backed repo asset renders in preview for a COMPLETED stage (WI #264)', async () => {
  const slug = 'preview-asset-completed'
  const ctxWithImage = readFileSync('instances/examples/modules/context.md', 'utf8').replace(
    '## Problem statement',
    '## Problem statement\n\n![Preview Img](../assets/figure-1.png)'
  )

  const files = {
    // instance.yaml on main has already advanced to hld-define — `shape` is a completed stage
    [`/gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: hld-define\n`,
    [`/gantry-workspace/${slug}/modules/context.md`]: ctxWithImage,
    [`/gantry-workspace/${slug}/modules/solution-definition.md`]: readFileSync(
      'instances/examples/modules/solution-definition.md',
      'utf8'
    ),
    [`/gantry-workspace/${slug}/modules/team-and-estimates.md`]: readFileSync(
      'instances/examples/modules/team-and-estimates.md',
      'utf8'
    ),
    [`/gantry-workspace/${slug}/modules/hld-submission.md`]: readFileSync(
      'instances/examples/modules/hld-submission.md',
      'utf8'
    ),
    // figure-1.png committed on main (as after the merged shape PR)
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

        // Stale leftover branch for the completed `shape` stage carries a BROKEN figure-1.png.
        const client = createAzureDevOpsClient({
          organization: ORGANIZATION,
          project: PROJECT,
          repository: REPOSITORY,
          pat: VALID_PAT,
          baseUrl,
        })
        const shapeBranch = `gantry-workspace/${slug}/shape`
        await client.createBranch(shapeBranch)
        await client.writeFile(`/gantry-workspace/${slug}/assets/figure-1.png`, 'THIS-IS-NOT-A-PNG', {
          branch: shapeBranch,
        })

        await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true }, async (gantryBase) => {
          const browser = await launchBrowser()
          try {
            const page = await browser.newPage()
            page.setDefaultTimeout(DEFAULT_TIMEOUT)

            await page.addInitScript((pat) => {
              localStorage.setItem('gantry:ado-pat', pat)
            }, VALID_PAT)
            await page.setExtraHTTPHeaders({ Authorization: basicAuthHeader(VALID_PAT) })

            await page.goto(`${gantryBase}/instance/${slug}`)
            await page.waitForSelector('.module', { timeout: 10_000 })

            // Free-browse to the completed `shape` stage (title "SOAP") via the stage switcher.
            await page.locator('#stage-nav button', { hasText: 'SOAP' }).click()

            const previewImg = page.locator('.preview img').first()
            await previewImg.waitFor({ timeout: 10_000 })
            // Wait until the preview img is pinned to the completed stage and has finished loading.
            await page.waitForFunction(
              () => {
                const img = document.querySelector('.preview img')
                return img && img.getAttribute('src')?.includes('stage=shape') && img.complete
              },
              { timeout: 15_000 }
            )

            const naturalWidth = await previewImg.evaluate((el) => el.naturalWidth)
            assert.ok(naturalWidth > 0, `expected naturalWidth >0 for the completed-stage preview, got ${naturalWidth}`)
            const src = await previewImg.getAttribute('src')
            assert.ok(
              src && src.includes('/api/instance/assets/figure-1.png/file'),
              `expected src to be the file endpoint, got ${src}`
            )
            assert.ok(src.includes('stage=shape'), `expected src to carry stage=shape, got ${src}`)
          } finally {
            await browser.close()
          }
        })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
})

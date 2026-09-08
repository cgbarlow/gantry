import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer, basicAuthHeader, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// WI314 — real, in-browser coverage for the client-side WASM Pandoc render path: a real
// pandoc-wasm instantiate and a real markdown→docx conversion (not mocked, unlike
// tests/pandocWasm.test.js's unit suite — this is that module's "does it actually work in a
// real browser" counterpart), asserted the same way the #310 prototype's own fidelity check
// did: convert the produced .docx back to markdown via native pandoc and check real content
// survived, plus a network-activity check (mirroring the prototype's own
// `performance.getEntriesByType('resource')` approach) that the WASM binary begins loading on
// gantry open, not gated behind any user action.

const SHAPE_MODULES = ['background', 'solution-definition', 'team-and-estimates', 'dependencies', 'soap-full-details', 'introduction']

function readExampleFile(relPath) {
  // WI #348: fixture text is borrowed for another instance with no asset manifest, so image references are stripped.
  return relPath.startsWith('modules/') ? exampleModuleText(relPath.slice('modules/'.length).replace(/\.md$/, '')) : readFileSync(join('instances/examples', relPath), 'utf8')
}

async function seedLocalWorkspace(page, slug) {
  const files = {
    [`gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: shape\nassignee: a.architect\ndefinitionVersion: 1\n`,
  }
  for (const moduleId of SHAPE_MODULES) {
    files[`gantry-workspace/${slug}/modules/${moduleId}.md`] = readExampleFile(`modules/${moduleId}.md`)
  }
  return page.evaluate(
    async ({ files, name }) => {
      const { rememberWorkspace } = await import('/lib/localWorkspace.js')
      async function writePath(dir, path, content) {
        const parts = path.split('/')
        const file = parts.pop()
        let d = dir
        for (const p of parts) d = await d.getDirectoryHandle(p, { create: true })
        const fh = await d.getFileHandle(file, { create: true })
        const w = await fh.createWritable()
        await w.write(content)
        await w.close()
      }
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle('local-ws-' + Date.now() + '-' + Math.random().toString(36).slice(2), { create: true })
      for (const [path, content] of Object.entries(files)) await writePath(dir, path, content)
      const id = await rememberWorkspace({ handle: dir, name })
      return id
    },
    { files, name: 'WASM Render Test Workspace' }
  )
}

async function readOpfsFileBase64(page, path) {
  return page.evaluate(async (path) => {
    const { getWorkspaceHandle, readBinaryFile } = await import('/lib/localWorkspace.js')
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('gantry-local-workspaces', 1)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const tx = db.transaction('workspaces', 'readonly')
    const all = await new Promise((resolve, reject) => {
      const req = tx.objectStore('workspaces').getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    db.close()
    const handle = await getWorkspaceHandle(all[0].id)
    const bytes = await readBinaryFile(handle, path)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
  }, path)
}

// Converts a real .docx's bytes back to markdown via native pandoc, run in this Node test
// process (not the browser) — the same fidelity-check shape tests/render.test.js's own
// Azure-DevOps tests already use, and the same approach the #310 prototype used to prove
// pandoc-wasm's `--reference-doc`-equivalent merge is byte-faithful.
function docxToMarkdown(docxBase64) {
  return execFileSync('pandoc', ['-f', 'docx', '-t', 'markdown'], {
    input: Buffer.from(docxBase64, 'base64'),
    encoding: 'utf8',
  })
}

test('the pandoc-wasm binary begins loading as soon as gantry opens — before any Preview/Render click, on the plain dashboard route', async () => {
  await withRunningServer({}, async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.goto(`${base}/`)
      // No click, no navigation to an instance, no Preview/Render — warm-load is fired from
      // web/app.js's own module-scope boot sequence.
      await page.waitForFunction(
        () => performance.getEntriesByType('resource').some((r) => r.name.includes('pandoc.wasm')),
        { timeout: 15_000 }
      )
      const wasmResource = await page.evaluate(
        () => performance.getEntriesByType('resource').find((r) => r.name.includes('pandoc.wasm'))
      )
      assert.ok(wasmResource, 'pandoc.wasm should appear in the resource timing list')
      assert.ok(wasmResource.transferSize > 0 || wasmResource.decodedBodySize > 0, 'pandoc.wasm should actually have transferred bytes, not a failed/aborted request')
    } finally {
      await browser.close()
    }
  })
})

test('a local-workspace Render produces a real, well-formed .docx via client-side WASM Pandoc — no /api/local/render call for the conversion itself — and Settings shows it live as ready', async () => {
  await withRunningServer({}, async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const requestedPaths = []
      page.on('request', (req) => {
        const url = new URL(req.url())
        if (url.pathname.startsWith('/api/local/')) requestedPaths.push(url.pathname)
      })

      const slug = 'wasm-local-render'
      await page.goto(`${base}/`)
      const workspaceId = await seedLocalWorkspace(page, slug)

      await page.goto(`${base}/instance/${slug}?local=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('.module', { timeout: 10_000 })

      // Render engine defaults to 'wasm' — no Settings visit needed to exercise the default path.
      await page.getByRole('button', { name: 'Render', exact: true }).click()
      const renderDialog = page.locator('.modal[aria-label="Render an artefact"]')
      await renderDialog.waitFor({ state: 'visible', timeout: 5_000 })
      await renderDialog.getByRole('button', { name: 'Solution on a Page', exact: true }).click()
      await renderDialog.locator('.modal-actions').getByRole('button', { name: 'Render' }).click()
      await page.waitForFunction(
        () => /rendered to|render failed/.test(document.querySelector('.modal[aria-label="Render an artefact"]')?.textContent ?? ''),
        { timeout: 30_000 }
      )
      const renderStatusText = await renderDialog.textContent()
      assert.doesNotMatch(renderStatusText, /render failed/, `WASM render must not fail: ${renderStatusText}`)
      await page.keyboard.press('Escape')
      await renderDialog.waitFor({ state: 'hidden', timeout: 5_000 })

      // The server-side compute this render actually used: /api/local/compile (markdown +
      // reference-doc bytes, dry run) — never /api/local/render, which would mean the
      // conversion happened server-side via native pandoc instead of in the browser.
      assert.ok(requestedPaths.includes('/api/local/compile'), `expected /api/local/compile among: ${requestedPaths.join(', ')}`)
      assert.ok(!requestedPaths.includes('/api/local/render'), `expected no /api/local/render call, got: ${requestedPaths.join(', ')}`)

      // The produced .docx, read back through the same File System Access handle the WASM
      // render itself wrote it to — a real file, converted back to markdown via native pandoc
      // to check real, expected content survived the WASM round-trip (the #310 prototype's own
      // fidelity-check approach).
      // The basename is "<Instance name> - <Artefact title>" (WI226,
      // renderedArtefactBasename) — the seeded instance.yaml sets no `name`
      // field, so instanceDisplayName falls back to titleCaseSlug(slug)
      // (lib/instance.js) instead of the local-workspace's own registered
      // name: each hyphen-separated word of "wasm-local-render" is
      // capitalised, except any word of 4 characters or fewer, which is
      // instead fully upper-cased (titleCaseSlug's own acronym-guessing
      // heuristic) — "wasm" (4 chars) becomes "WASM", not "Wasm".
      const docxBase64 = await readOpfsFileBase64(page, `gantry-workspace/${slug}/out/WASM Local Render - Solution on a Page.docx`)
      assert.equal(Buffer.from(docxBase64, 'base64').subarray(0, 2).toString(), 'PK', '.docx should start with a PK zip header')
      const markdown = docxToMarkdown(docxBase64)
      assert.match(markdown, /Solution on a Page/)
      assert.match(markdown, /Document Control/)

      // The Settings status line reflects real, live state — not a static claim — once the
      // module that just did the conversion above is (by now, certainly) ready.
      await page.goto(`${base}/settings`)
      await page.waitForSelector('.settings-section:has-text("Render engine")', { timeout: 10_000 })
      // `:has-text` is a Playwright-only selector extension — valid for `waitForSelector`
      // above (Playwright's own selector engine), not for `document.querySelector` inside
      // `waitForFunction` below (real in-page JS, no such pseudo-selector exists natively).
      // The "Render engine" section is confirmed present by the wait above, so a plain,
      // native-compatible body-text check is enough to catch the live status line.
      await page.waitForFunction(() => document.body.textContent?.includes('Pandoc WASM: ready'), { timeout: 10_000 })
    } finally {
      await browser.close()
    }
  })
})

test('switching Settings\' Render engine to Native persists across reload and routes the next local render through the server-side path instead', async () => {
  await withRunningServer({}, async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)

      const slug = 'wasm-native-switch'
      await page.goto(`${base}/`)
      const workspaceId = await seedLocalWorkspace(page, slug)

      await page.goto(`${base}/settings`)
      await page.waitForSelector('.settings-section:has-text("Render engine")', { timeout: 10_000 })
      await page.locator('.settings-radio', { hasText: 'Native Pandoc' }).locator('input[type=radio]').click()
      await page.reload()
      await page.waitForSelector('.settings-section:has-text("Render engine")', { timeout: 10_000 })
      assert.equal(
        await page.locator('.settings-radio', { hasText: 'Native Pandoc' }).locator('input[type=radio]').isChecked(),
        true,
        'the Native selection should survive a reload (persisted to localStorage, same as advancedMode/theme)'
      )

      const requestedPaths = []
      page.on('request', (req) => {
        const url = new URL(req.url())
        if (url.pathname.startsWith('/api/local/')) requestedPaths.push(url.pathname)
      })

      await page.goto(`${base}/instance/${slug}?local=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('.module', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Render', exact: true }).click()
      const renderDialog = page.locator('.modal[aria-label="Render an artefact"]')
      await renderDialog.waitFor({ state: 'visible', timeout: 5_000 })
      await renderDialog.getByRole('button', { name: 'Solution on a Page', exact: true }).click()
      await renderDialog.locator('.modal-actions').getByRole('button', { name: 'Render' }).click()
      await page.waitForFunction(
        () => /rendered to|render failed/.test(document.querySelector('.modal[aria-label="Render an artefact"]')?.textContent ?? ''),
        { timeout: 30_000 }
      )
      const renderStatusText = await renderDialog.textContent()
      assert.doesNotMatch(renderStatusText, /render failed/, `native render must not fail: ${renderStatusText}`)

      assert.ok(requestedPaths.includes('/api/local/render'), `expected /api/local/render among: ${requestedPaths.join(', ')}`)
      assert.ok(!requestedPaths.includes('/api/local/compile'), `an explicit Native selection must never call /api/local/compile, got: ${requestedPaths.join(', ')}`)
    } finally {
      await browser.close()
    }
  })
})

test('an Azure-DevOps-hosted Render produces a real, well-formed .docx via client-side WASM Pandoc, pushed to Azure DevOps exactly as the native path would push it', async () => {
  const slug = 'wasm-ado-render'
  const files = {
    [`/gantry-workspace/${slug}/instance.yaml`]: readFileSync('instances/examples/instance.yaml', 'utf8').replace(/^slug: examples$/m, `slug: ${slug}`),
    [`/gantry-workspace/${slug}/modules/background.md`]: exampleModuleText('background'),
    [`/gantry-workspace/${slug}/modules/introduction.md`]: exampleModuleText('introduction'),
    [`/gantry-workspace/${slug}/modules/design-basis.md`]: exampleModuleText('design-basis'),
    [`/gantry-workspace/${slug}/modules/solution-definition.md`]: exampleModuleText('solution-definition'),
    [`/gantry-workspace/${slug}/modules/team-and-estimates.md`]: exampleModuleText('team-and-estimates'),
  }

  await withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        registerInstance(slug, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })

        await withRunningServer({ instancesDir }, async (gantryBase) => {
          const browser = await launchBrowser()
          try {
            const page = await browser.newPage()
            page.setDefaultTimeout(DEFAULT_TIMEOUT)
            await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)
            await page.setExtraHTTPHeaders({ Authorization: basicAuthHeader(VALID_PAT) })

            const requestedPaths = []
            page.on('request', (req) => {
              const url = new URL(req.url())
              if (url.pathname.startsWith('/api/instance/render')) requestedPaths.push(url.pathname)
            })

            await page.goto(`${gantryBase}/instance/${slug}`)
            await page.waitForSelector('.module', { timeout: 10_000 })

            await page.getByRole('button', { name: 'Render', exact: true }).click()
            const renderDialog = page.locator('.modal[aria-label="Render an artefact"]')
            await renderDialog.waitFor({ state: 'visible', timeout: 5_000 })
            await renderDialog.getByRole('button', { name: 'Solution on a Page', exact: true }).click()
            await renderDialog.locator('.modal-actions').getByRole('button', { name: 'Render' }).click()
            await page.waitForFunction(
              () => /rendered to|render failed/.test(document.querySelector('.modal[aria-label="Render an artefact"]')?.textContent ?? ''),
              { timeout: 30_000 }
            )
            const renderStatusText = await renderDialog.textContent()
            assert.doesNotMatch(renderStatusText, /render failed/, `WASM render must not fail: ${renderStatusText}`)

            assert.ok(requestedPaths.some((p) => p.startsWith('/api/instance/render-wasm-prepare/')), `expected a render-wasm-prepare call among: ${requestedPaths.join(', ')}`)
            assert.ok(requestedPaths.some((p) => p.startsWith('/api/instance/render-wasm-finish/')), `expected a render-wasm-finish call among: ${requestedPaths.join(', ')}`)
            assert.ok(!requestedPaths.some((p) => p === '/api/instance/render/soap'), `an explicit WASM render must never fall back to the fully-server-side route, got: ${requestedPaths.join(', ')}`)

            // What's actually sitting in the (fake) Azure DevOps repo now — pushed exactly as
            // today's server-rendered flow already does — is a real, well-formed .docx whose
            // content survives the round trip.
            const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
            const items = await client.listFolder(`gantry-workspace/${slug}/out`, { branch: `gantry-workspace/${slug}/shape` })
            const docxItem = items.find((i) => i.path.endsWith('.docx'))
            assert.ok(docxItem, `expected a rendered .docx in the pushed branch, got: ${items.map((i) => i.path).join(', ')}`)
            const content = await client.getFileContent(docxItem.path, { branch: `gantry-workspace/${slug}/shape` })
            assert.equal(Buffer.from(content, 'base64').subarray(0, 2).toString(), 'PK')
            const markdown = docxToMarkdown(content)
            assert.match(markdown, /Solution on a Page/)
            assert.match(markdown, /Document Control/)
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

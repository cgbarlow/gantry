import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// WI #353 — real, in-browser coverage for Mermaid rendering (web/lib/mermaid.js): the vendored
// mermaid bundle loads through the same `/node_modules/` route pandoc-wasm uses, a ```mermaid
// fence in a field renders as an inline SVG in the editor preview, and a local-workspace Render
// through client-side WASM Pandoc embeds that diagram in the .docx as a PNG while the .md
// written alongside keeps the fenced source. tests/mermaid.test.js covers the DOM-free scanner.

const SHAPE_MODULES = ['background', 'solution-definition', 'team-and-estimates', 'dependencies', 'soap-full-details', 'introduction', 'design-basis']

const MERMAID_BLOCK = ['```mermaid', 'flowchart LR', '  Author --> Gantry --> Artefact', '```'].join('\n')

async function seedLocalWorkspace(page, slug) {
  const files = {
    [`gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: shape\nassignee: a.architect\ndefinitionVersion: 2\n`,
  }
  for (const moduleId of SHAPE_MODULES) {
    let text = exampleModuleText(moduleId)
    if (moduleId === 'background') {
      // Append the diagram to the Problem statement — the first field of the first shape module.
      text = text.replace(/^## Affected domains$/m, `${MERMAID_BLOCK}\n\n## Affected domains`)
    }
    files[`gantry-workspace/${slug}/modules/${moduleId}.md`] = text
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
      const dir = await root.getDirectoryHandle('mermaid-ws-' + Date.now() + '-' + Math.random().toString(36).slice(2), { create: true })
      for (const [path, content] of Object.entries(files)) await writePath(dir, path, content)
      return rememberWorkspace({ handle: dir, name })
    },
    { files, name: 'Mermaid Render Test Workspace' }
  )
}

async function readOpfsFile(page, path, { binary }) {
  return page.evaluate(
    async ({ path, binary }) => {
      const { getWorkspaceHandle, readBinaryFile, readTextFile } = await import('/lib/localWorkspace.js')
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
      if (!binary) return readTextFile(handle, path)
      const bytes = await readBinaryFile(handle, path)
      let s = ''
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
      return btoa(s)
    },
    { path, binary }
  )
}

test('a ```mermaid fence renders as an SVG in the preview, and a WASM Render embeds it in the .docx as a PNG while the .md keeps the source', async () => {
  await withRunningServer({}, async (base) => {
    const browser = await launchBrowser()
    const mediaDir = mkdtempSync(join(tmpdir(), 'gantry-mermaid-media-'))
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const consoleErrors = []
      page.on('pageerror', (err) => consoleErrors.push(String(err)))

      const slug = 'mermaid-local-render'
      await page.goto(`${base}/`)
      const workspaceId = await seedLocalWorkspace(page, slug)

      await page.goto(`${base}/instance/${slug}?local=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('.module', { timeout: 10_000 })

      // Visual view (#374): the fence is swapped for a figure holding a real <svg> once the bundle loads.
      // The editor only draws what is on screen, and the diagram sits at the end of a long field.
      await page.locator('.field-markdown').first().evaluate((el) => el.scrollIntoView({ block: 'end' }))
      const figure = page.locator('.field-markdown .md-rendered figure.mermaid-diagram svg').first()
      await figure.waitFor({ state: 'visible', timeout: 30_000 })
      assert.ok(
        await page.evaluate(() => performance.getEntriesByType('resource').some((r) => r.name.includes('/node_modules/mermaid/dist/mermaid.esm.min.mjs'))),
        'the mermaid bundle must be served from node_modules, never a CDN'
      )
      assert.equal(await page.locator('.field-markdown .md-rendered pre > code.language-mermaid').count(), 0, 'no raw mermaid code block should remain in the drawing')
      assert.match(await figure.innerHTML(), /Gantry/, 'the rendered SVG should carry the diagram text')

      // The docx preparation step on its own, so a rasterisation failure is reported as itself
      // rather than as "the docx still has the source".
      const prepared = await page.evaluate(async (block) => {
        const { prepareMermaidForDocx } = await import('/lib/mermaid.js')
        const out = await prepareMermaidForDocx(`Before\n\n${block}\n\nAfter\n`)
        return { markdown: out.markdown, files: Object.keys(out.files), size: (await out.files['mermaid-diagram-1.png']?.arrayBuffer())?.byteLength ?? 0 }
      }, MERMAID_BLOCK)
      assert.deepEqual(prepared.files, ['mermaid-diagram-1.png'], `expected one PNG, got markdown: ${prepared.markdown}`)
      assert.ok(prepared.size > 100, 'the PNG should have real bytes')
      assert.match(prepared.markdown, /!\[Diagram 1\]\(mermaid-diagram-1\.png\)/)

      // Render via the default WASM engine — docx format (WI #359's default). A docx-format
      // render no longer also persists the .md sidecar (see editor-local-workspace's own
      // updated assertion for the same behaviour); the fenced-source guarantee below is
      // exercised separately, by explicitly selecting the md format.
      await page.getByRole('button', { name: 'Render', exact: true }).click()
      const renderDialog = page.locator('.modal[aria-label="Render an artefact"]')
      await renderDialog.waitFor({ state: 'visible', timeout: 5_000 })
      await renderDialog.getByRole('button', { name: 'Solution on a Page', exact: true }).click()
      await renderDialog.locator('.modal-actions').getByRole('button', { name: 'Render' }).click()
      await page.waitForFunction(
        () => /rendered to|render failed/.test(document.querySelector('.modal[aria-label="Render an artefact"]')?.textContent ?? ''),
        { timeout: 60_000 }
      )
      const renderStatusText = await renderDialog.textContent()
      assert.doesNotMatch(renderStatusText, /render failed/, `WASM render must not fail: ${renderStatusText}`)

      const basename = 'Mermaid Local Render - Solution on a Page'
      const docxBase64 = await readOpfsFile(page, `gantry-workspace/${slug}/out/${basename}.docx`, { binary: true })
      const roundTrip = execFileSync('pandoc', ['-f', 'docx', '-t', 'markdown', `--extract-media=${mediaDir}`], {
        input: Buffer.from(docxBase64, 'base64'),
        encoding: 'utf8',
      })
      assert.ok(!roundTrip.includes('flowchart LR'), 'the docx must not carry the Mermaid source as a code block')
      const media = readdirSync(join(mediaDir, 'media'))
      assert.ok(media.some((f) => f.endsWith('.png')), `the docx should embed a PNG, got: ${media.join(', ')}`)

      // WI #359 — still the same open dialog: switch to the md format and render again. No PNG
      // rasterisation this time, the fenced Mermaid source is preserved as-is, and no .md was
      // written by the docx render above.
      await renderDialog.getByRole('radio', { name: 'md' }).check()
      await renderDialog.locator('.modal-actions').getByRole('button', { name: 'Render' }).click()
      await page.waitForFunction(
        () => /rendered to|render failed/.test(document.querySelector('.modal[aria-label="Render an artefact"]')?.textContent ?? ''),
        { timeout: 20_000 }
      )
      const mdRenderStatusText = await renderDialog.textContent()
      assert.doesNotMatch(mdRenderStatusText, /render failed/, `md-format render must not fail: ${mdRenderStatusText}`)

      const md = await readOpfsFile(page, `gantry-workspace/${slug}/out/${basename}.md`, { binary: false })
      assert.ok(md.includes('```mermaid'), 'the exported .md keeps the fenced Mermaid source')
      assert.ok(!md.includes('mermaid-diagram-1.png'), 'the exported .md never references the docx-only PNG')

      assert.deepEqual(consoleErrors, [], 'no uncaught page errors')
    } finally {
      rmSync(mediaDir, { recursive: true, force: true })
      await browser.close()
    }
  })
})

test('a Mermaid block with a syntax error keeps its source in the preview with an error note, and never breaks the rest of the preview', async () => {
  await withRunningServer({}, async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const slug = 'mermaid-bad-block'
      await page.goto(`${base}/`)
      const workspaceId = await page.evaluate(async ({ slug }) => {
        const { rememberWorkspace } = await import('/lib/localWorkspace.js')
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('mermaid-bad-' + Date.now(), { create: true })
        const ws = await dir.getDirectoryHandle('gantry-workspace', { create: true })
        const inst = await ws.getDirectoryHandle(slug, { create: true })
        const mods = await inst.getDirectoryHandle('modules', { create: true })
        async function write(d, name, content) {
          const fh = await d.getFileHandle(name, { create: true })
          const w = await fh.createWritable()
          await w.write(content)
          await w.close()
        }
        await write(inst, 'instance.yaml', `definition: design\nslug: ${slug}\nstage: shape\nassignee: a.architect\ndefinitionVersion: 2\n`)
        await write(mods, 'background.md', '---\nmodule: background\nstatus: draft\n---\n# Background\n\n## Problem statement\nBefore.\n\n```mermaid\nthis is not a diagram %%%\n```\n\nAfter.\n\n## Affected domains\n- One\n')
        return rememberWorkspace({ handle: dir, name: 'Bad Mermaid' })
      }, { slug })
      await page.goto(`${base}/instance/${slug}?local=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('.module', { timeout: 10_000 })
      const note = page.locator('.field-markdown .md-rendered .mermaid-error-note').first()
      await note.waitFor({ state: 'visible', timeout: 30_000 })
      assert.match(await note.textContent(), /^Mermaid: /)
      assert.equal(await page.locator('.field-markdown .md-rendered pre.mermaid-error code.language-mermaid').count(), 1, 'the source stays visible')
      const previewText = await page.locator('.field-markdown .cm-content').first().textContent()
      assert.ok(previewText.includes('Before.') && previewText.includes('After.'), 'surrounding prose still renders')
    } finally {
      await browser.close()
    }
  })
})

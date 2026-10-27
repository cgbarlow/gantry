import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { readModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'

// #195 (spec #192, ADR-0053) — the browser half of Diagram captions: what only a real browser
// does. The editor draws a captioned Mermaid fence with its caption under it and keeps the
// caption through a Visual-view edit, and the default WASM render draws the diagram into the
// .docx as a picture captioned "Diagram N. <title>", numbered in one sequence with the
// document's captioned images. The native path's numbering is covered by
// tests/diagramCaptions.test.js.

const EXAMPLE = 'workspaces/examples/kiwi-cover-mutual'
const SECURITY_FENCE = '```mermaid {caption="Security architecture"}\nflowchart LR\n  Member --> Portal --> CRM\n```'

async function withExampleServer(fn, { edit } = {}) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-captions-e2e-'))
  try {
    cpSync(EXAMPLE, join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
    if (edit) edit(join(instancesDir, 'examples'))
    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 1000 } })
        const page = await context.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })
        await fn({ page, pageErrors, instancesDir })
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

async function chooseMode(page, label) {
  await page.locator('.view-mode-dropdown').getByRole('button', { name: /^Mode/ }).click()
  await page.getByRole('menuitemradio', { name: label, exact: true }).click()
}

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

// Every caption in a .docx, with the paragraph holding its figure.
function captionedFigures(docxPath) {
  const xml = execFileSync('unzip', ['-p', docxPath, 'word/document.xml'], { encoding: 'utf8' })
  const ps = [...xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>/g)].map(([, body]) => ({
    style: body.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? null,
    text: decode([...body.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('')),
    alt: body.includes('<w:drawing>') ? decode(body.match(/<wp:docPr [^>]*descr="([^"]*)"/)?.[1] ?? '') : null,
  }))
  return ps.flatMap((p, i) => (p.style === 'ImageCaption' ? [{ caption: p.text, figure: ps[i - 1] }] : []))
}

test('Visual view draws a captioned Mermaid fence with its caption under it, and an edit to the diagram keeps the caption (#195)', async () => {
  await withExampleServer(async ({ page, pageErrors, instancesDir }) => {
    const field = page.locator('.module').first().locator('.field-markdown').first()
    const text = `Intro.\n\n${SECURITY_FENCE}\n\nOutro.`
    await chooseMode(page, 'Markdown')
    await field.locator('.cm-content').click()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.insertText(text)
    await chooseMode(page, 'Visual')

    const diagram = field.locator('.cm-visual-mermaid')
    await diagram.locator('figure.mermaid-diagram svg').waitFor({ timeout: 30_000 })
    assert.equal(await diagram.locator('figure.mermaid-diagram figcaption').textContent(), 'Security architecture')

    await diagram.getByRole('button', { name: 'Edit diagram text' }).click()
    const pop = page.locator('.vgrid-popover')
    assert.equal(await pop.locator('textarea').inputValue(), 'flowchart LR\n  Member --> Portal --> CRM')
    await pop.locator('textarea').fill('flowchart LR\n  Member --> Portal --> CRM --> Ledger')
    await pop.getByRole('button', { name: 'Apply' }).click()
    await diagram.locator('figure.mermaid-diagram svg').waitFor({ timeout: 30_000 })
    assert.match(await diagram.innerHTML(), /Ledger/)
    assert.equal(await diagram.locator('figure.mermaid-diagram figcaption').textContent(), 'Security architecture')

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await page.waitForSelector('text=Saved', { timeout: 5_000 })
    const saved = readModule(loadDefinition('design'), 'examples', 'background', { instancesDir: join(instancesDir, 'default') }).fields.problem
    assert.equal(saved, text.replace('CRM\n', 'CRM --> Ledger\n'), 'the fence line, caption and all, is saved as written')
    assert.deepEqual(pageErrors, [])
  })
})

test('the default WASM render draws a captioned Mermaid block into the .docx as "Diagram 1. <title>", numbered before the captioned images (#195)', async () => {
  await withExampleServer(
    async ({ page }) => {
      await page.getByRole('button', { name: 'Render', exact: true }).click()
      const renderDialog = page.locator('.modal[aria-label="Render an artefact"]')
      await renderDialog.waitFor({ state: 'visible', timeout: 5_000 })
      await renderDialog.getByRole('button', { name: 'Solution on a Page', exact: true }).click()
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        renderDialog.locator('.modal-actions').getByRole('button', { name: 'Render' }).click(),
      ])
      const figures = captionedFigures(await download.path())
      assert.deepEqual(
        figures.map((f) => f.caption),
        ['Diagram 1. Security architecture', 'Diagram 2. Take out insurance process', 'Diagram 3. Claims handling introductory view']
      )
      for (const { caption, figure } of figures) {
        assert.equal(figure.style, 'CaptionedFigure', `"${caption}" sits directly under its figure, kept with it`)
        assert.equal(figure.alt, caption, 'the caption doubles as the picture\'s alt text')
      }
    },
    {
      edit: (instanceDir) => {
        const path = join(instanceDir, 'modules', 'background.md')
        writeFileSync(path, readFileSync(path, 'utf8').replace(/\n## Affected domains/, `\n${SECURITY_FENCE}\n\n## Affected domains`))
      },
    }
  )
})

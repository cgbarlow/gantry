import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { captionedFigures } from './helpers/docxFigures.js'

// #198 (spec #192, ADR-0055) — `gantry render` *with* the optional headless Chromium installed
// (Playwright's, as the e2e suite already has): it draws each Mermaid block with the browser's own
// code (web/lib/mermaid.js), so the .docx carries the same pictures, under the same image names, at
// the same scale and with the same "Diagram N. <title>" captions as the browser's export of the same
// instance. The second test is the drift guard: it renders one instance both ways and compares every
// figure. The CLI without Chromium is tests/cliMermaid.test.js.

const SLUG = 'examples'
const EXAMPLE = 'workspaces/examples/kiwi-cover-mutual'
const SECURITY_FENCE = '```mermaid {caption="Security architecture"}\nflowchart LR\n  Member --> Portal --> CRM\n```'
const PLAIN_FENCE = '```mermaid\nflowchart LR\n  Claim --> Assessor\n```'

// A scratch copy of the bundled example (design v3: every Artefact numbers its diagrams) with a
// captioned and an uncaptioned Mermaid block added ahead of its two captioned images.
function seedExample(instanceDir) {
  cpSync(EXAMPLE, instanceDir, { recursive: true })
  rmSync(join(instanceDir, 'out'), { recursive: true, force: true })
  assert.match(readFileSync(join(instanceDir, 'instance.yaml'), 'utf8'), /^definitionVersion: 3$/m)
  const path = join(instanceDir, 'modules', 'background.md')
  const before = readFileSync(path, 'utf8')
  const after = before.replace(/\n## Affected domains/, `\n${SECURITY_FENCE}\n\n${PLAIN_FENCE}\n\n## Affected domains`)
  assert.notEqual(after, before)
  writeFileSync(path, after)
}

function withScratch(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-cli-mermaid-e2e-'))
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => rmSync(root, { recursive: true, force: true }))
}

function cliRender(workspacesDir) {
  const run = spawnSync(process.execPath, ['bin/gantry.js', 'render', SLUG, 'soap', '--workspaces-dir', workspacesDir], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  const docxPath = run.stdout.match(/^Rendered (.+\.docx)$/m)?.[1]
  assert.ok(docxPath, run.stdout)
  return { docxPath, stderr: run.stderr }
}

async function browserExport(root) {
  const instancesDir = join(root, 'server')
  seedExample(join(instancesDir, SLUG))
  let docxPath
  await withRunningServer({ slug: SLUG, instancesDir }, async (base) => {
    const browser = await launchBrowser()
    try {
      const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 1000 } })
      const page = await context.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.goto(`${base}/instance/${SLUG}`)
      await page.waitForSelector('.module', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Render', exact: true }).click()
      const renderDialog = page.locator('.modal[aria-label="Render an artefact"]')
      await renderDialog.waitFor({ state: 'visible', timeout: 5_000 })
      await renderDialog.getByRole('button', { name: 'Solution on a Page', exact: true }).click()
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        renderDialog.locator('.modal-actions').getByRole('button', { name: 'Render' }).click(),
      ])
      docxPath = join(root, 'browser.docx')
      await download.saveAs(docxPath)
    } finally {
      await browser.close()
    }
  })
  return docxPath
}

test('with Chromium, `gantry render` draws each Mermaid block as a captioned PNG figure, with no warning (#198)', async () => {
  await withScratch(async (root) => {
    const workspacesDir = join(root, 'cli')
    seedExample(join(workspacesDir, SLUG))
    const { docxPath, stderr } = cliRender(workspacesDir)
    assert.doesNotMatch(stderr, /Mermaid/)

    const figures = captionedFigures(docxPath)
    assert.deepEqual(
      figures.map((f) => f.caption),
      ['Diagram 1. Security architecture', 'Diagram 2', 'Diagram 3. Claims handling introductory view', 'Diagram 4. Take out insurance process']
    )
    const [security, plain] = figures
    assert.equal(security.name, 'mermaid-diagram-1.png')
    assert.equal(plain.name, 'mermaid-diagram-2.png')
    for (const figure of figures) {
      assert.equal(figure.style, 'CaptionedFigure', `"${figure.caption}" sits directly under its figure, kept with it`)
      assert.equal(figure.alt, figure.caption, "the caption doubles as the picture's alt text")
    }
    for (const diagram of [security, plain]) {
      assert.ok(diagram.width > 0 && diagram.height > 0, 'a real PNG')
      assert.equal(diagram.width % 2, 0, 'drawn at 2x, like the browser export')
      assert.equal(diagram.height % 2, 0, 'drawn at 2x, like the browser export')
    }

    // The source stays authoritative: nothing in the instance changed.
    assert.ok(readFileSync(join(workspacesDir, SLUG, 'modules', 'background.md'), 'utf8').includes(SECURITY_FENCE))
  })
})

test('drift guard: the CLI and the browser export draw the same instance into the same figures, names, scale and captions (#198)', async () => {
  await withScratch(async (root) => {
    const workspacesDir = join(root, 'cli')
    seedExample(join(workspacesDir, SLUG))
    const cli = captionedFigures(cliRender(workspacesDir).docxPath)
    const browser = captionedFigures(await browserExport(root))

    // An uploaded image's recorded name is wherever each path read it from (an absolute path on
    // disk for the CLI, a virtual file for the browser's Pandoc), so it is left out; everything
    // else about every figure, and all of each Mermaid picture, must match.
    const comparable = (figures) => figures.map((f) => (f.name.startsWith('mermaid-diagram-') ? f : { ...f, name: '(uploaded image)' }))
    assert.equal(cli.filter((f) => f.name.startsWith('mermaid-diagram-')).length, 2)
    assert.deepEqual(comparable(cli), comparable(browser))
  })
})

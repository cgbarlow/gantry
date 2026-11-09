import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { V3_REFERENCES, withV3References } from './helpers/designExamples.js'

// #359: design v4 in the browser. The Stage editor shows the bundled example, now on v4, with Teams
// required and Estimates and no References Field; and an Instance moved to v4 with its References
// section still in team-and-estimates.md shows it as an added section, the way Gantry shows any `##`
// section the Definition has no Field for (#132).

const SLUG = 'kiwi-cover-mutual'
const MODULE_TITLE = 'Teams, contact persons, and high-level estimates'

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()) })
    await fn(page)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

// A server over a scratch copy of the Examples workspace; `prepare` may change the copy first.
async function withExamplesServer(fn, prepare = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'design-359-browser-'))
  try {
    const examples = join(root, 'examples')
    cpSync('workspaces/examples', examples, { recursive: true })
    prepare(examples)
    await withRunningServer({ instancesDir: root }, fn)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// The Field and section titles the Shape Stage shows for team-and-estimates, without the required marker.
async function teamAndEstimatesTitles(page, base) {
  await page.goto(`${base}/instance/${SLUG}`)
  const module = page.locator('.module', { hasText: MODULE_TITLE })
  await module.first().waitFor({ state: 'visible', timeout: 10_000 })
  return (await module.first().locator('.field > label').allTextContents()).map((t) => t.replace(/ \*$/, '').trim())
}

test('Stage editor: the example on v4 shows Teams required and Estimates, and no References', () =>
  withExamplesServer((base) => withPage(async (page) => {
    assert.deepEqual(await teamAndEstimatesTitles(page, base), ['Teams required', 'Estimates'])
  })))

test('Stage editor: a References section left in team-and-estimates.md on v4 shows as an added section, with its items', () =>
  withExamplesServer((base) => withPage(async (page) => {
    assert.deepEqual(await teamAndEstimatesTitles(page, base), ['Teams required', 'Estimates', 'References'])
    const module = page.locator('.module', { hasText: MODULE_TITLE }).first()
    const item = V3_REFERENCES[SLUG].split('\n').find((line) => line.startsWith('- ')).slice(2)
    assert.ok((await module.textContent()).includes(item) || (await module.locator('input, textarea').evaluateAll((els, text) => els.some((el) => el.value === text), item)), `the section shows "${item}"`)
  }), (examples) => {
    const file = join(examples, SLUG, 'modules', 'team-and-estimates.md')
    writeFileSync(file, withV3References(SLUG, readFileSync(file, 'utf8')))
  }))

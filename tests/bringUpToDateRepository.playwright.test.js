import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { showFields, showSourcesAndDecisions } from './helpers/referenceView.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { seedProviders, withFakeAnthropic } from './helpers/interviewStandIn.js'
import { serializeDecisionsLog } from '../web/lib/decisionsLog.js'

// #357: Bring up to date from the editor's banner on a Local Workspace whose Fields drew on a code repository, the shape the architect reported:
// the Instance is on Detailed Design, and Fields drafted on SOAP, High-level Design and Detailed Design drew on files of `gantry` that have
// since changed, as the Gantry server's compare (a stand-in here, answering slowly) says. Two more Fields drew on a Field that has since
// changed. The banner's Bring up to date must land on a page with something to do, say it is checking the repository while it is, and work
// through each Stage until nothing is flagged. A working copy of an earlier Bring up to date, left in the browser with no open round, must not
// hide the kickoff either.

const SLUG = 'local-repo'
const DRAFTED = '2026-10-01T00:00:00.000Z'
const COMPARE_MS = 2500
const GANTRY = { provider: 'github', location: { owner: 'cgbarlow', repository: 'gantry' }, branch: 'main' }

const moduleText = (id, title, fields, status = 'draft') =>
  `---\nmodule: ${id}\nstatus: ${status}\nowner: a.architect\n---\n# ${title}\n\n${fields.map(([heading, body]) => `## ${heading}\n\n${body}\n`).join('\n')}`

// The Field each Stage's AI drafted, and the files of `gantry` (or the earlier Field) it drew on.
const read = (path) => ({ source: 'gantry', title: 'gantry', path, commit: 'c1' })
const log = (stage, fields) =>
  serializeDecisionsLog({
    version: 1,
    stage,
    status: [{ session: `s-${stage}`, who: 'a.architect', target: stage, state: 'done', lastAiSave: DRAFTED }],
    fields: Object.fromEntries(Object.entries(fields).map(([key, inputs]) => [key, { drafted: DRAFTED, inputs, entries: [] }])),
    entries: [],
  })

const FILES = {
  'instance.yaml': `definition: design\nslug: ${SLUG}\nstage: detailed-design\nassignee: a.architect\ndefinitionVersion: 3\n`,
  'modules/background.md': moduleText('background', 'Background and context', [
    ['Problem statement', 'Claims take 12 days.'],
    ['Affected domains', 'Claims.'],
  ]),
  'modules/proposed-solution.md': moduleText('proposed-solution', 'Proposed Solution', [
    ['Guardrails', 'Keep to the platform, as now agreed.'],
    ['Alignment with strategy', 'Cloud first.'],
  ]),
  'modules/architecture.md': moduleText('architecture', 'Architecture', [
    ['Business context', 'Claims are lodged online.'],
    ['Solution users', 'Claims officers.'],
  ]),
  'sources/manifest.yaml': `- id: gantry\n  title: gantry\n  uploadedBy: a.architect\n  uploadedAt: '2026-09-01T00:00:00.000Z'\n  repository:\n    provider: github\n    location:\n      owner: cgbarlow\n      repository: gantry\n    branch: main\n`,
  'interview/shape.yaml': log('shape', {
    'background.problem': [read('package.json'), read('README.md')],
    'background.affected-domains': [read('CONTEXT.md')],
  }),
  'interview/hld-define.yaml': log('hld-define', {
    'proposed-solution.guardrails': [read('package.json')],
    'proposed-solution.strategy-alignment': [read('lib/server.js')],
  }),
  'interview/detailed-design.yaml': log('detailed-design', {
    // Drew on a file of gantry, and on a Field whose text is no longer what the draft saw.
    'architecture.business-context': [read('package.json'), { field: 'proposed-solution.guardrails', title: 'Guardrails', fingerprint: 'not-what-it-says-now' }],
    'architecture.solution-users': [{ field: 'background.problem', title: 'Problem statement', fingerprint: 'not-what-it-says-now' }],
  }),
}
// Every file gantry's Fields drew on has changed since c1, except README.md. The branch head is h2: a Field answered at h2 is up to date.
const CHANGED = new Set(['package.json', 'CONTEXT.md', 'lib/server.js'])

const cardIds = (page) => page.locator('[data-testid="interview-card"]').evaluateAll((els) => els.map((el) => el.dataset.cardId))
const keep = (page, card) => page.locator(`[data-testid="interview-card"][data-card-id="${card}"] [data-testid="card-option"][data-option="Keep"] input`).check()
const stageOnPage = (page) => page.textContent('.interview-rail .interview-instance + .cite')

async function withLocalRepositoryWorkspace(fn) {
  await withFakeAnthropic(
    () => ({ text: 'Nothing to do.' }),
    (aiBase, posts) =>
      withRunningServer({ allowPrivateAiUrls: true }, async (base) => {
        const browser = await launchBrowser()
        try {
          const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
          page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
          const pageErrors = []
          page.on('pageerror', (err) => pageErrors.push(err.message))
          await seedProviders(page, aiBase)
          // The Gantry server's repository reads, stood in for: access checks pass, and a compare answers slowly, as a real one does.
          const compares = []
          await page.route('**/api/sources/repository', async (route) => {
            const body = JSON.parse(route.request().postData() ?? '{}')
            if (body.action === 'compare') {
              compares.push(body)
              await new Promise((resolve) => setTimeout(resolve, COMPARE_MS))
              const results = (body.reads ?? []).map((r) => ({ path: r.path, commit: r.commit, changed: r.commit !== 'h2' && CHANGED.has(r.path), deleted: false }))
              return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ head: 'h2', results }) })
            }
            return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, commit: 'h2' }) })
          })
          await page.goto(`${base}/settings`)
          const workspaceId = await page.evaluate(
            async ({ slug, files }) => {
              const { rememberWorkspace } = await import('/lib/localWorkspace.js')
              const root = await navigator.storage.getDirectory()
              const dir = await root.getDirectoryHandle('local-ws-' + Date.now(), { create: true })
              const instanceDir = await (await dir.getDirectoryHandle('gantry-workspace', { create: true })).getDirectoryHandle(slug, { create: true })
              for (const [path, text] of Object.entries(files)) {
                const parts = path.split('/')
                let folder = instanceDir
                for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create: true })
                const w = await (await folder.getFileHandle(parts[parts.length - 1], { create: true })).createWritable()
                await w.write(text)
                await w.close()
              }
              return rememberWorkspace({ handle: dir, name: 'Local Repository Workspace' })
            },
            { slug: SLUG, files: FILES }
          )
          const readFile = (path) =>
            page.evaluate(
              async ({ path }) => {
                const { readTextFile } = await import('/lib/localWorkspace.js')
                const root = await navigator.storage.getDirectory()
                for await (const [name, handle] of root.entries()) {
                  if (!name.startsWith('local-ws-')) continue
                  try {
                    return await readTextFile(handle, path)
                  } catch {
                    // not this one
                  }
                }
                return null
              },
              { path }
            )
          const editor = `${base}/instance/${SLUG}?local=${encodeURIComponent(workspaceId)}`
          await fn({ page, editor, posts, compares, readFile })
          assert.deepEqual(pageErrors, [])
        } finally {
          await browser.close()
        }
      })
  )
}

// Opens the editor, waits for the banner (the compare answers first), and clicks its Bring up to date.
async function bringUpToDateFromBanner(page, editor) {
  await page.goto(editor)
  await page.waitForSelector('.module', { timeout: 15_000 })
  await showSourcesAndDecisions(page)
  await page.locator('[data-testid="source-documents"]').waitFor({ timeout: 15_000 })
  await showFields(page)
  await page.locator('[data-testid="out-of-date-banner"]').waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="out-of-date-line"]').length === 2, null, { timeout: 20_000 })
  await page.click('[data-testid="bring-up-to-date"]')
}

// On the Stage the page is on: Start, Keep every card, save the round. Returns the cards it answered.
async function keepEveryCard(page) {
  await page.waitForSelector('[data-testid="interview-start"]:not([disabled])', { timeout: 20_000 })
  assert.match(await page.textContent('[data-testid="interview-start"]'), /Bring up to date/)
  await page.click('[data-testid="interview-start"]')
  await page.waitForSelector('[data-testid="interview-round"]')
  const ids = await cardIds(page)
  for (const id of ids) await keep(page, id)
  await page.click('[data-testid="round-submit"]')
  await page.click('[data-testid="update-save"]')
  await page.waitForSelector('[data-testid="update-saved"]')
  return ids
}

test('local workspace, code repository: Bring up to date from the banner says it is checking the repository, then works Stage by Stage until nothing is flagged', async () => {
  await withLocalRepositoryWorkspace(async ({ page, editor, posts, readFile }) => {
    await bringUpToDateFromBanner(page, editor)

    // It lands on SOAP, the first Stage with a flagged Field. While the repository is compared again for this Stage the page says so, and never
    // that nothing is Out of date.
    await page.waitForSelector('[data-testid="interview-update-intro"]')
    await page.waitForFunction(() => /SOAP/.test(document.querySelector('.interview-rail .interview-instance + .cite')?.textContent ?? ''))
    await page.waitForSelector('[data-testid="interview-update-checking"]')
    assert.match(await page.textContent('[data-testid="interview-update-checking"]'), /Checking .*gantry/)
    assert.equal(await page.locator('[data-testid="interview-update-none"]').count(), 0, 'it does not say nothing is Out of date while it is still checking')
    assert.equal(await page.locator('[data-testid="interview-start"]').isDisabled(), true)

    // Once the compare answers: the count, and the button.
    await page.waitForSelector('[data-testid="interview-update-count"]', { timeout: 20_000 })
    assert.equal(await page.locator('[data-testid="interview-update-checking"]').count(), 0)
    assert.match(await page.textContent('[data-testid="interview-update-count"]'), /^2 Fields on SOAP are Out of date/)
    assert.match(await page.textContent('[data-testid="interview-update-next"]'), /on High-level Design are Out of date too/)
    const soap = await keepEveryCard(page)
    assert.deepEqual(soap.sort(), ['update:background.affected-domains', 'update:background.problem'])

    // Next: High-level Design, then Detailed Design, each answered the same way.
    await page.click('[data-testid="update-next-button"]')
    await page.waitForFunction(() => /High-level Design/.test(document.querySelector('.interview-rail .interview-instance + .cite')?.textContent ?? ''))
    await page.waitForSelector('[data-testid="interview-update-count"]', { timeout: 20_000 })
    assert.match(await page.textContent('[data-testid="interview-update-count"]'), /^2 Fields on High-level Design are Out of date/)
    const hld = await keepEveryCard(page)
    assert.deepEqual(hld.sort(), ['update:proposed-solution.guardrails', 'update:proposed-solution.strategy-alignment'])

    await page.click('[data-testid="update-next-button"]')
    await page.waitForFunction(() => /Detailed Design/.test(document.querySelector('.interview-rail .interview-instance + .cite')?.textContent ?? ''))
    await page.waitForSelector('[data-testid="interview-update-count"]', { timeout: 20_000 })
    // The Field that drew on gantry and on an earlier Field, and the Field that drew only on an earlier Field, are both asked about here.
    assert.match(await page.textContent('[data-testid="interview-update-count"]'), /^2 Fields on Detailed Design are Out of date/)
    const dd = await keepEveryCard(page)
    assert.deepEqual(dd.sort(), ['update:architecture.business-context', 'update:architecture.solution-users'])
    assert.equal(await page.locator('[data-testid="update-next"]').count(), 0, 'nothing is left on another Stage')
    assert.equal(posts.length, 0, 'keeping every Field needs no AI')

    // Every answer is in the log of the Stage it was given on.
    const dlog = parseYAML(await readFile(`gantry-workspace/${SLUG}/interview/detailed-design.yaml`))
    const answered = dlog.entries.filter((e) => e.kind === 'source-update').flatMap((e) => e.fields)
    assert.deepEqual([...new Set(answered)].sort(), ['architecture.business-context', 'architecture.solution-users'])

    // Back in the editor, nothing is Out of date.
    await page.click('[data-testid="update-back-to-editor"]')
    await page.waitForSelector('.module')
    await showSourcesAndDecisions(page)
    await page.locator('[data-testid="source-documents"]').waitFor({ timeout: 15_000 })
    await showFields(page)
    await page.waitForTimeout(COMPARE_MS + 1500)
    assert.equal(await page.locator('[data-testid="out-of-date-banner"]').count(), 0)
  })
})

test('local workspace, code repository: a working copy of an earlier Bring up to date with no open round still offers the kickoff', async () => {
  await withLocalRepositoryWorkspace(async ({ page, editor }) => {
    // An earlier Bring up to date on SOAP left a working copy in this browser: its round was answered and the AI's turn ended, but it was
    // never saved, and its answers name a Field that is no longer flagged.
    await page.goto(editor)
    await page.waitForSelector('.module', { timeout: 15_000 })
    await page.evaluate((slug) => {
      const key = `${slug}|shape|update`
      const update = { mode: 'only', total: 2, answered: false, reopen: [], deferred: [], elsewhere: [] }
      const state = { sessionId: 's-old', state: { phase: 'waiting', thread: [{ who: 'ai', text: 'Done.' }], round: null, drafts: {}, update }, log: { sessionId: 's-old', pending: [] } }
      localStorage.setItem(`gantry:interview-copy:${key}`, JSON.stringify({ version: 1, savedAt: '2026-10-02T00:00:00.000Z', session: 's-old', committedIds: [], lastAiSave: null, state }))
    }, SLUG)
    await bringUpToDateFromBanner(page, editor)
    await page.waitForFunction(() => /SOAP/.test(document.querySelector('.interview-rail .interview-instance + .cite')?.textContent ?? ''))
    await page.waitForSelector('[data-testid="interview-update-count"]', { timeout: 20_000 })
    assert.match(await page.textContent('[data-testid="interview-update-count"]'), /^2 Fields on SOAP are Out of date/)
    assert.equal(await page.locator('[data-testid="interview-copy-restored"]').count(), 0, 'the stale copy is not picked up')
    const soap = await keepEveryCard(page)
    assert.deepEqual(soap.sort(), ['update:background.affected-domains', 'update:background.problem'])
    assert.equal(await page.evaluate((slug) => localStorage.getItem(`gantry:interview-copy:${slug}|shape|update`), SLUG), null, 'the stale copy is gone')
  })
})

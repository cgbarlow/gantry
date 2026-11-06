import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { stageBranchName } from '../lib/stageBranch.js'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'
import { writeTrio } from './helpers/trioDefinition.js'
import { seedProviders, withFakeAnthropic } from './helpers/interviewStandIn.js'
import { PROVIDERS, ROOT, SLUG as REMOTE_SLUG, open, waitState as remoteWaitState, withRemoteTrio } from './helpers/remoteTrio.js'

// #350: a Not ready yet card shows what keeps a Stage from its stage-end card. A real server and relay, a real Chromium page and a stand-in
// for Anthropic on the three-Stage trio with Scope mounting a shared Module (tests/helpers/trioDefinition.js `shared`), so Scope's Gate
// needs Scope notes · Body and Shared notes · Body; here Scope notes · Body also has a word budget (about 24 to 40 words). The stand-in
// drafts Scope notes · Body far too short, never the shared one, and answers Gantry's note (#349) with a sentence, so the turn ends with
// the Stage not ready. The list on the card is the one the AI is told (tests/interviewNotReady.test.js covers the wording).

const SLUG = 'not-ready-test'
const NOTE = "Gantry's check: the Stage is not ready yet"
const ASK_LEAD = 'Please finish these, so the Stage is ready:'
const words = (n) => Array.from({ length: n }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}`).join(' ')
const draft = (id, field, value) => ({ id, input: { field, value } })

// The text of the last user turn of an Anthropic request (a turn of tool results has none).
function lastUserText(body) {
  const m = body.messages.filter((x) => x.role === 'user').at(-1)
  return typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}

// The first reply drafts Scope notes · Body short and asks who owns the shared notes; Ask the AI to finish these gets both Fields drafted.
const script = (body) => {
  const said = lastUserText(body)
  if (body.messages.length === 1) {
    const owner = { id: 'ask', name: 'ask_architect', input: { questions: [{ header: 'Shared notes', question: 'Who writes the shared notes?', field: 'mx.body', options: [{ label: 'Pat' }, { label: 'Sam' }], recommended: 'Pat', why: 'Pat wrote them last time.' }] } }
    return { text: 'Reading for s1.', tools: [draft('d1', 'm1.body', words(5)), owner] }
  }
  if (said.startsWith(ASK_LEAD)) return { text: 'Finishing them.', tools: [draft('d2', 'm1.body', words(30)), draft('d3', 'mx.body', 'Shared position set at s1.')] }
  if (said.startsWith(NOTE)) return { text: 'The shared notes need your word before I write them.' }
  return { text: 'Scope is drafted.' }
}

const row = (page, id) => page.locator(`[data-testid="run-plan-row"][data-stage-id="${id}"]`)
const items = (page) => page.$$eval('[data-testid="interview-not-ready-item"]', (els) => els.map((e) => e.textContent.trim().replace(/\s+/g, ' ')))
const readYaml = (file) => parseYAML(readFileSync(file, 'utf8'))
function instanceFolder(instancesDir) {
  for (const candidate of [join(instancesDir, 'default', SLUG), join(instancesDir, SLUG)]) if (existsSync(join(candidate, 'instance.yaml'))) return candidate
  throw new Error('no instance folder')
}

async function withNotReadyServer(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-350-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  const browser = await launchBrowser()
  try {
    writeTrio(definitionsDir, { shared: true })
    writeFileSync(join(definitionsDir, 'trio', '1', 'modules', 'm1.yaml'), 'id: m1\ntitle: Scope notes\nfields:\n  - id: body\n    title: Body\n    type: markdown\n    required: true\n    target-words: { small: 10, medium: 40, large: 80 }\n')
    mkdirSync(instancesDir)
    createInstance('trio', SLUG, { instancesDir, definitionsDir, definitionVersion: 1 })
    await withFakeAnthropic(script, (aiBase, posts) =>
      withRunningServer({ slug: SLUG, instancesDir, definitionsDir, allowPrivateAiUrls: true }, async (base) => {
        const page = await browser.newPage({ viewport: { width: 1500, height: 900 } })
        page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
        page.on('dialog', (dialog) => dialog.accept())
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        await seedProviders(page, aiBase)
        await page.goto(`${base}/instance/${SLUG}?interview=1`)
        await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
        await page.click('[data-testid="interview-start"]')
        // While the round is open there is no card of either kind.
        await page.waitForSelector('[data-testid="interview-round"]')
        assert.equal(await page.locator('[data-testid="interview-not-ready"]').count(), 0)
        assert.equal(await page.locator('[data-testid="interview-stage-end"]').count(), 0)
        await page.click('[data-testid="round-submit"]')
        await page.waitForSelector('[data-testid="interview-not-ready"]')
        await fn({ page, base, posts, instancesDir })
        assert.deepEqual(pageErrors, [])
      })
    )
  } finally {
    await browser.close()
    rmSync(root, { recursive: true, force: true })
  }
}

const EXPECTED = ['The Gate check for Scope document: outstanding Shared notes · Body', 'Scope notes · Body: 5 words, needs about 24 to 40', 'Shared notes · Body: no content yet']

test('server workspace: the Not ready yet card names what is outstanding, links each Field to the preview, and Save and stop here saves and pauses without advancing', async () => {
  await withNotReadyServer(async ({ page, base, posts, instancesDir }) => {
    // What's outstanding, in the words the AI was told (with the Fields' keys left out).
    assert.deepEqual(await items(page), EXPECTED)
    const note = posts.map((p) => lastUserText(p.body)).find((t) => t.startsWith(NOTE))
    assert.ok(note.includes('- The Gate check for Scope document: outstanding Shared notes · Body (mx.body)'), note)
    assert.ok(note.includes('- Scope notes · Body (m1.body): 5 words, needs about 24 to 40'), note)
    assert.equal(await page.locator('[data-testid="interview-stage-end"]').count(), 0)
    assert.match(await page.textContent('[data-testid="interview-not-ready-stop-note"]'), /saved, not finished/)
    // The run plan says the Stage is still being drafted, not awaiting confirmation.
    assert.equal(await row(page, 's1').getAttribute('data-state'), 'drafting')

    // Announced once: one line in the status region, which does not change while the card is up.
    assert.equal(await page.locator('[data-testid="interview-not-ready-announce"]').count(), 1)
    assert.match(await page.textContent('[data-testid="interview-not-ready-announce"]'), /Scope isn't ready yet/)
    assert.equal(await page.locator('[data-testid="interview-not-ready"] [role="status"], [data-testid="interview-not-ready"][aria-live]').count(), 0, 'the card is not a live region of its own')

    // By keyboard: each Field's name is a button, and it takes the live draft preview to that Field.
    const link = page.locator('[data-testid="interview-not-ready-field"][data-field-key="mx.body"]')
    assert.equal(await link.evaluate((el) => el.tagName), 'BUTTON')
    await link.focus()
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-field-key') === 'mx.body')
    const inView = await page.evaluate(() => {
      const r = document.activeElement.getBoundingClientRect()
      return r.top >= 0 && r.top < window.innerHeight
    })
    assert.ok(inView, 'the Field is scrolled into view')
    for (const id of ['interview-not-ready-ask', 'interview-not-ready-save']) assert.equal(await page.locator(`[data-testid="${id}"]`).evaluate((el) => el.tagName), 'BUTTON')
    assert.match(await page.textContent('[data-testid="interview-not-ready-ask"]'), /RECOMMENDED/)

    // Save and stop here: one Save of the content and the decisions log, the run paused here, nothing advanced.
    await page.click('[data-testid="interview-not-ready-save"]')
    await page.waitForSelector('[data-testid="interview-paused"]')
    assert.match(await page.textContent('[data-testid="interview-paused"]'), /saved, not finished/)
    await page.waitForSelector('[data-testid="run-plan-row"][data-stage-id="s1"][data-state="paused"]')
    assert.equal(await page.locator('[data-testid="interview-not-ready"]').count(), 0)
    const folder = instanceFolder(instancesDir)
    const m1 = readFileSync(join(folder, 'modules', 'm1.md'), 'utf8')
    assert.match(m1, /worda wordb wordc wordd worde/)
    assert.match(m1, /status: draft/)
    const log = readYaml(join(folder, 'interview', 's1.yaml'))
    assert.equal(log.status.at(-1).state, 'paused')
    assert.equal(readYaml(join(folder, 'instance.yaml')).stage, 's1')

    // Advance to next stage still checks the Gate, and refuses: the shared notes are still empty.
    const advance = await fetch(`${base}/api/instance/advance-stage?slug=${SLUG}`, { method: 'POST' })
    assert.equal(advance.ok, false)
    assert.equal(readYaml(join(folder, 'instance.yaml')).stage, 's1')
  })
})

test('server workspace: Ask the AI to finish these sends the list as the architect\'s message, and the stage-end card takes the card\'s place once the Stage is ready', async () => {
  await withNotReadyServer(async ({ page, posts }) => {
    const before = posts.length
    await page.click('[data-testid="interview-not-ready-ask"]')
    // While the AI works there is no card.
    await page.waitForSelector('[data-testid="interview-status"]')
    assert.equal(await page.locator('[data-testid="interview-not-ready"]').count(), 0)
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    assert.equal(await page.locator('[data-testid="interview-not-ready"]').count(), 0)
    assert.equal(await page.locator('[data-testid="interview-not-ready-announce"]').count(), 0)
    assert.equal(lastUserText(posts[before].body), [ASK_LEAD, ...EXPECTED.map((line) => `- ${line}`)].join('\n'))
    const mine = await page.$$eval('[data-testid="interview-msg"][data-who="you"]', (els) => els.map((e) => e.textContent))
    assert.ok(mine.some((t) => t.includes(ASK_LEAD)), 'the message is the architect\'s, in the thread')
    assert.equal(await row(page, 's1').getAttribute('data-state'), 'awaiting-confirmation')
  })
})

// On Azure DevOps and GitHub the same card's Save and stop here asks for no approval: no Pull Request, the run paused.
const remoteScript = (body) => {
  const said = lastUserText(body)
  if (body.messages.length === 1) return { text: 'Reading for s1.', tools: [draft('d1', 'm1.body', 'Notes for s1: the agreed position, written out.')] }
  if (said.startsWith(NOTE)) return { text: 'The shared notes are yours to write.' }
  return { text: 'Scope is drafted.' }
}

for (const spec of PROVIDERS) {
  test(`${spec.name}: Save and stop here on the Not ready yet card saves on the Stage's branch and asks for no approval`, async () => {
    await withRemoteTrio(
      spec,
      async ({ page, base, client, api }) => {
        await open(page, base)
        await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
        await page.click('[data-testid="interview-start"]')
        await page.waitForSelector('[data-testid="interview-not-ready"]')
        assert.deepEqual(await items(page), ['The Gate check for Scope document: outstanding Shared notes · Body', 'Shared notes · Body: no content yet'])
        await page.click('[data-testid="interview-not-ready-save"]')
        await page.waitForSelector('[data-testid="interview-paused"]')
        await remoteWaitState(page, 's1', 'paused')
        const branch = stageBranchName(REMOTE_SLUG, 's1')
        assert.match(await client.getFileContent(`${ROOT}/modules/m1.md`, { branch }), /Notes for s1/)
        assert.equal(parseYAML(await client.getFileContent(`${ROOT}/interview/s1.yaml`, { branch })).status.at(-1).state, 'paused')
        await page.waitForTimeout(1000)
        assert.equal((await (await api('/api/instance')).json()).pullRequests?.s1, undefined, 'no Pull Request was opened')
        assert.equal(await page.locator('[data-testid="interview-awaiting-approval"]').count(), 0)
      },
      { shared: true, script: remoteScript }
    )
  })
}

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'
import { writeTrio } from './helpers/trioDefinition.js'
import { seedProviders, trioStageOf, withFakeAnthropic } from './helpers/interviewStandIn.js'

// #331: the kickoff's optional box, sent as the architect's opening message. A real server and relay, a real Chromium page and a stand-in
// for Anthropic, on the three-Stage trio. What the session does with the words (where they go in the request, a round that comes first, the
// status block, Start this stage over) is covered under node --test in tests/interviewSession.test.js and the session tests of Bring up to
// date and review comments; this is the screen and the run: the box, the thread, every Stage of a run starting with the same words, and a
// run resumed in a fresh browser.

const SLUG = 'opening-test'
const WORDS = 'Focus on the hosting decision; the budget is capped at NZD 1.2M.'
const MODULE = { s1: 'm1', s2: 'm2', s3: 'm3' }

// The first turn of a Stage (nothing from the AI in it yet) drafts its one Field, a little differently when it resumes; the turn after the
// draft result is a short reply.
const script = (body) => {
  const stage = trioStageOf(body)
  const resuming = JSON.stringify(body.messages[0]).includes('Resume the interview')
  const value = `Notes for ${stage}${resuming ? ', resumed' : ''}: the agreed position, written out.`
  if (body.messages.every((m) => m.role === 'user')) return { text: `Reading for ${stage}.`, tools: [{ id: `d-${stage}`, input: { field: `${MODULE[stage]}.body`, value } }] }
  return { text: `${stage} is drafted.` }
}

const textOf = (message) => (typeof message.content === 'string' ? message.content : message.content.map((b) => b.text ?? '').join('\n'))
// The first request the AI got for each Stage, in order.
const firstRequests = (posts) => posts.filter((p) => p.body.messages.every((m) => m.role === 'user')).map((p) => ({ stage: trioStageOf(p.body), body: p.body }))

const readYaml = (file) => parseYAML(readFileSync(file, 'utf8'))
function instanceFolder(instancesDir) {
  for (const candidate of [join(instancesDir, 'default', SLUG), join(instancesDir, SLUG)]) if (existsSync(join(candidate, 'instance.yaml'))) return candidate
  throw new Error('no instance folder')
}

// A browser; `open()` gives a page in a fresh browser profile each time (its own storage), with the stand-in AI Provider in it.
async function withBrowser(aiBase, fn) {
  const browser = await launchBrowser()
  const pageErrors = []
  try {
    const open = async () => {
      const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
      const page = await context.newPage()
      page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
      page.on('pageerror', (err) => pageErrors.push(err.message))
      await seedProviders(page, aiBase)
      return page
    }
    await fn(open)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

async function withTrioServer(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-331-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  try {
    writeTrio(definitionsDir)
    mkdirSync(instancesDir)
    createInstance('trio', SLUG, { instancesDir, definitionsDir, definitionVersion: 1 })
    await withFakeAnthropic(script, (aiBase, posts) =>
      withRunningServer({ slug: SLUG, instancesDir, definitionsDir, allowPrivateAiUrls: true }, (base) => withBrowser(aiBase, (open) => fn({ open, base, posts, instancesDir })))
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const yours = (page) => page.locator('[data-testid="interview-msg"][data-who="you"]').allTextContents()
const assertCarries = (request, stage) => {
  assert.equal(request.stage, stage)
  assert.equal(request.body.messages.length, 2, `${stage}: Gantry's opening, then the architect's words`)
  assert.equal(textOf(request.body.messages[1]), WORDS, `${stage}: word for word`)
  assert.ok(!JSON.stringify(request.body.system).includes(WORDS), `${stage}: never in the system prompt`)
}

// ---------- a server workspace ----------

test('server workspace: the opening message goes with the first request of every Stage of the run, shows as yours, and is recorded with the session', async () => {
  await withTrioServer(async ({ open, base, posts, instancesDir }) => {
    const page = await open()
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-opening"]')
    assert.equal(await page.inputValue('[data-testid="interview-opening"]'), '', 'blank to start with')
    assert.match(await page.textContent('label[for="interview-opening"]'), /Anything the AI should know before it starts\? \(optional\)/)
    assert.match(await page.getAttribute('[data-testid="interview-opening"]', 'placeholder'), /hosting decision/)
    assert.ok(
      await page.evaluate(() => {
        const box = document.querySelector('[data-testid="interview-opening"]')
        const start = document.querySelector('[data-testid="interview-start"]')
        return Boolean(box.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING)
      }),
      'the box sits above Start'
    )

    await page.selectOption('[data-testid="interview-run-until"]', 's2')
    await page.fill('[data-testid="interview-opening"]', WORDS)
    await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    assert.deepEqual(await yours(page), [WORDS], 'the thread shows it as your message')

    // Carry on: Shape starts by itself, with the same words.
    await page.click('[data-testid="interview-save-advance"]')
    await page.waitForSelector('[data-testid="interview-field"][data-field-key="m2.body"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    assert.deepEqual(await yours(page), [WORDS], 'Shape\'s thread opens with it too')
    const [scope, shape] = firstRequests(posts)
    assertCarries(scope, 's1')
    assertCarries(shape, 's2')
    await page.click('[data-testid="interview-save"]')
    await page.waitForSelector('[data-testid="interview-run-done"]')

    const folder = instanceFolder(instancesDir)
    for (const stage of ['s1', 's2']) assert.equal(readYaml(join(folder, 'interview', `${stage}.yaml`)).status[0].opening, WORDS, `${stage}'s status block keeps the words`)
  })
})

test('server workspace: a run paused after a Stage and resumed in a fresh browser starts the next Stage with the same opening message', async () => {
  await withTrioServer(async ({ open, base, posts }) => {
    const first = await open()
    await first.goto(`${base}/instance/${SLUG}?interview=1`)
    await first.waitForSelector('[data-testid="interview-run-until"]')
    await first.selectOption('[data-testid="interview-run-until"]', 's2')
    await first.fill('[data-testid="interview-opening"]', WORDS)
    await first.click('[data-testid="interview-start"]')
    await first.waitForSelector('[data-testid="interview-stage-end"]')
    await first.click('[data-testid="interview-save"]')
    await first.waitForSelector('[data-testid="interview-run-paused"]')
    await first.close()

    // Another browser knows nothing of the run but what the decisions log says.
    const second = await open()
    await second.goto(`${base}/instance/${SLUG}?interview=1`)
    await second.waitForSelector('[data-testid="interview-resume-note"]')
    assert.equal(await second.inputValue('[data-testid="interview-opening"]'), '', 'the box is blank: nothing is remembered')
    await second.click('[data-testid="interview-resume"]')
    await second.waitForSelector('[data-testid="interview-field"][data-field-key="m2.body"]')
    await second.waitForSelector('[data-testid="interview-stage-end"]')
    assert.deepEqual(await yours(second), [WORDS])
    const requests = firstRequests(posts)
    assert.equal(requests.length, 2)
    assertCarries(requests[1], 's2')
  })
})

test('server workspace: a session paused part-way and resumed in a fresh browser keeps its opening message, and so does the rest of its run', async () => {
  await withTrioServer(async ({ open, base, posts }) => {
    const first = await open()
    await first.goto(`${base}/instance/${SLUG}?interview=1`)
    await first.waitForSelector('[data-testid="interview-run-until"]')
    await first.fill('[data-testid="interview-opening"]', WORDS)
    await first.click('[data-testid="interview-start"]')
    await first.waitForSelector('[data-testid="interview-stage-end"]')
    await first.click('[data-testid="interview-pause"]')
    await first.waitForSelector('[data-testid="interview-paused"]')
    await first.close()

    const second = await open()
    await second.goto(`${base}/instance/${SLUG}?interview=1`)
    await second.waitForSelector('[data-testid="interview-resume-recap"]')
    assert.equal(await second.inputValue('[data-testid="interview-opening"]'), '')
    await second.selectOption('[data-testid="interview-run-until"]', 's2')
    await second.click('[data-testid="interview-start"]')
    // Scope's Field was saved by the Pause, so the AI's redraft of it meets the keep / use / merge card first.
    await second.waitForSelector('[data-testid="interview-card"][data-card-id="change:m1.body"]')
    await second.locator('[data-testid="interview-card"][data-card-id="change:m1.body"] [data-testid="card-option"][data-option="Use the AI\'s version"] input').check()
    await second.click('[data-testid="round-submit"]')
    await second.waitForSelector('[data-testid="interview-stage-end"]')
    const resumed = firstRequests(posts)[1]
    assert.equal(resumed.stage, 's1')
    assert.match(textOf(resumed.body.messages[0]), /Resume the interview/)
    assert.equal(textOf(resumed.body.messages[1]), WORDS, 'the paused session\'s words, from its status block')

    await second.click('[data-testid="interview-save-advance"]')
    await second.waitForSelector('[data-testid="interview-field"][data-field-key="m2.body"]')
    await second.waitForSelector('[data-testid="interview-stage-end"]')
    assertCarries(firstRequests(posts)[2], 's2')
  })
})

test('server workspace: Start this stage over comes back to a blank box, and a start with nothing typed sends what it always did', async () => {
  await withTrioServer(async ({ open, base, posts }) => {
    const page = await open()
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-opening"]')
    await page.fill('[data-testid="interview-opening"]', WORDS)
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    await page.click('[data-testid="interview-restart"]')
    await page.click('[data-testid="interview-restart-yes"]')
    await page.waitForSelector('[data-testid="interview-opening"]')
    assert.equal(await page.inputValue('[data-testid="interview-opening"]'), '')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    assert.deepEqual(await yours(page), [])
    const again = firstRequests(posts)[1]
    assert.equal(again.body.messages.length, 1, 'only Gantry\'s opening')
  })
})

// ---------- a Local workspace ----------

test('local workspace: every Stage of the run starts with the opening message, and the decisions logs keep it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gantry-331-'))
  const definitionsDir = join(root, 'definitions')
  try {
    writeTrio(definitionsDir)
    await withFakeAnthropic(script, (aiBase, posts) =>
      withRunningServer({ definitionsDir, allowPrivateAiUrls: true }, (base) =>
        withBrowser(aiBase, async (open) => {
          const page = await open()
          await page.goto(`${base}/settings`)
          const workspaceId = await page.evaluate(async () => {
            const { rememberWorkspace } = await import('/lib/localWorkspace.js')
            const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('local-ws-' + Date.now(), { create: true })
            const sub = await (await dir.getDirectoryHandle('gantry-workspace', { create: true })).getDirectoryHandle('local-opening', { create: true })
            const w = await (await sub.getFileHandle('instance.yaml', { create: true })).createWritable()
            await w.write('definition: trio\nslug: local-opening\nstage: s1\nassignee: a.architect\ndefinitionVersion: 1\n')
            await w.close()
            return rememberWorkspace({ handle: dir, name: 'Local Opening Workspace' })
          })
          await page.goto(`${base}/instance/local-opening?local=${encodeURIComponent(workspaceId)}&interview=1`)
          await page.waitForSelector('[data-testid="interview-opening"]')
          assert.equal(await page.inputValue('[data-testid="interview-opening"]'), '')
          await page.selectOption('[data-testid="interview-run-until"]', 's2')
          await page.fill('[data-testid="interview-opening"]', WORDS)
          await page.click('[data-testid="interview-start"]')
          await page.waitForSelector('[data-testid="interview-stage-end"]')
          assert.deepEqual(await yours(page), [WORDS])
          await page.click('[data-testid="interview-save-advance"]')
          await page.waitForSelector('[data-testid="interview-field"][data-field-key="m2.body"]')
          await page.waitForSelector('[data-testid="interview-stage-end"]')
          assert.deepEqual(await yours(page), [WORDS])
          await page.click('[data-testid="interview-save"]')
          await page.waitForSelector('[data-testid="interview-run-done"]')
          const [scope, shape] = firstRequests(posts)
          assertCarries(scope, 's1')
          assertCarries(shape, 's2')

          const logs = await page.evaluate(async () => {
            const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
            const db = await new Promise((resolve, reject) => {
              const req = indexedDB.open('gantry-local-workspaces', 1)
              req.onsuccess = () => resolve(req.result)
              req.onerror = () => reject(req.error)
            })
            const all = await new Promise((resolve, reject) => {
              const req = db.transaction('workspaces', 'readonly').objectStore('workspaces').getAll()
              req.onsuccess = () => resolve(req.result)
              req.onerror = () => reject(req.error)
            })
            db.close()
            const handle = await getWorkspaceHandle(all[0].id)
            return Promise.all(['s1', 's2'].map((stage) => readTextFile(handle, `gantry-workspace/local-opening/interview/${stage}.yaml`)))
          })
          for (const text of logs) assert.equal(parseYAML(text).status[0].opening, WORDS)
        })
      )
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

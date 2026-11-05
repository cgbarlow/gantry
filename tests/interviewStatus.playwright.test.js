import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'
import { writeTrio } from './helpers/trioDefinition.js'

// #341: the AI interview always shows what it is doing. A real server and relay, a real Chromium page and a stand-in for Anthropic on the
// three-Stage trio, which takes its time the way a real model does: a wait before the first byte, a sentence, a pause, then a long draft
// of Scope's one Field. What the session says when is covered under node --test in tests/interviewStatus.test.js and the remembered
// refusal in tests/aiClient.test.js; this is the screen: the one status line, its seconds, a refusal of the temperature setting that a
// reload remembers, and Start this stage over confirming where the architect is looking.

const SLUG = 'status-test'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const event = (res, name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)

// The stand-in. The first request of a fresh interview waits `firstByteMs`, writes a sentence, pauses, then writes the draft in two pieces
// with a pause between; a resumed one and every later request answer with a short sentence. `refuseTemperature` answers a request that
// carries a temperature with the 400 the newest Claude models give.
function withSlowAnthropic({ firstByteMs = 2500, pauseMs = 1500, refuseTemperature = false } = {}, fn) {
  const posts = []
  const refusals = []
  const upstream = createHttpServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'claude-small', max_input_tokens: 200000 }] }))
        return
      }
      const body = JSON.parse(raw)
      posts.push(body)
      if (refuseTemperature && body.temperature !== undefined) {
        refusals.push(body)
        await wait(300)
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: '`temperature` may only be set to 1 for this model.' } }))
        return
      }
      const fresh = body.messages.length === 1 && !JSON.stringify(body.messages[0]).includes('Resume the interview')
      await wait(fresh ? firstByteMs : 600)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      event(res, 'message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } })
      const text = fresh ? "I'll draft what the Tech LT deck supports." : body.messages.length === 1 ? 'Carrying on from the decisions log.' : 's1 is drafted.'
      event(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      event(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
      event(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
      if (fresh) {
        await wait(pauseMs)
        event(res, 'content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'd-s1', name: 'draft_field', input: {} } })
        event(res, 'content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"field":"m1.body",' } })
        await wait(pauseMs)
        event(res, 'content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"value":"Notes for s1: the agreed position, written out."}' } })
        event(res, 'content_block_stop', { type: 'content_block_stop', index: 1 })
      }
      event(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: fresh ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } })
      event(res, 'message_stop', { type: 'message_stop' })
      res.end()
    })
  })
  return new Promise((resolve, reject) => {
    upstream.listen(0, '127.0.0.1', async () => {
      try {
        await fn(`http://127.0.0.1:${upstream.address().port}`, { posts, refusals })
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        upstream.close()
      }
    })
  })
}

// One tested, Default AI Provider pointing at the stand-in, with the temperature the architect set.
const seed = (page, aiBase, { temperature = null } = {}) => {
  const passed = { status: 'passed', testedAt: '2026-11-02T00:00:00Z', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }
  const list = [{ id: 'one', name: 'First AI', type: 'anthropic', address: aiBase, key: 'key-one', model: 'claude-small', isDefault: true, temperature, test: passed }]
  return page.addInitScript((value) => localStorage.setItem('gantry:ai-providers', value), JSON.stringify(list))
}

async function withTrio(options, fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-341-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  const browser = await launchBrowser()
  const pageErrors = []
  try {
    writeTrio(definitionsDir)
    mkdirSync(instancesDir)
    createInstance('trio', SLUG, { instancesDir, definitionsDir, definitionVersion: 1 })
    await withSlowAnthropic(options, (aiBase, ai) =>
      withRunningServer({ slug: SLUG, instancesDir, definitionsDir, allowPrivateAiUrls: true }, async (base) => {
        // `open()` gives a page in a fresh browser profile each time (its own storage), with the stand-in AI Provider in it.
        const open = async ({ temperature = null } = {}) => {
          const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
          const page = await context.newPage()
          page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
          page.on('pageerror', (err) => pageErrors.push(err.message))
          await seed(page, aiBase, { temperature })
          return page
        }
        await fn({ open, base, ai })
      })
    )
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
    rmSync(root, { recursive: true, force: true })
  }
}

// Every 50 ms, what the status line says (null when it isn't there), from now on.
const watchStatus = (page) =>
  page.evaluate(() => {
    window.__status = []
    window.__statusTimer = setInterval(() => {
      const line = document.querySelector('[data-testid="interview-status"]')
      window.__status.push(line ? { activity: line.getAttribute('data-activity'), text: line.querySelector('[data-testid="interview-status-text"]').textContent, detail: line.querySelector('[data-testid="interview-status-detail"]')?.textContent ?? null } : null)
    }, 50)
  })
const seenStatus = (page) => page.evaluate(() => (clearInterval(window.__statusTimer), window.__status))

test('the status line stays up the whole time the AI is busy: Waiting with a count that goes up, Writing, then the Field being drafted', async () => {
  await withTrio({}, async ({ open, base }) => {
    const page = await open()
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-status"][data-activity="waiting"]')
    await watchStatus(page)
    const line = page.locator('[data-testid="interview-status"]')
    // An accessible status: announced politely, and the seconds are not announced every second.
    assert.equal(await page.locator('.interview-status').getAttribute('role'), 'status')
    assert.equal(await page.locator('.interview-status').getAttribute('aria-live'), 'polite')
    assert.equal(await line.locator('[data-testid="interview-status-detail"]').getAttribute('aria-hidden'), 'true')
    assert.equal(await line.locator('[data-testid="interview-status-text"]').textContent(), 'Waiting for the AI…')
    await page.waitForFunction(() => /^[2-9] s$/.test(document.querySelector('[data-testid="interview-status-detail"]')?.textContent ?? ''))

    await page.waitForSelector('[data-testid="interview-status"][data-activity="drafting"]')
    assert.equal(await line.locator('[data-testid="interview-status-text"]').textContent(), 'Drafting Scope notes · Body…')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    await page.waitForSelector('[data-testid="interview-status"]', { state: 'detached' })
    const seen = await seenStatus(page)

    // From the first wait to the end of the turn the line was never missing, and it said each thing in turn.
    const last = seen.findLastIndex(Boolean)
    assert.ok(seen.slice(0, last + 1).every(Boolean), 'never hidden while the AI was busy')
    const steps = seen.filter(Boolean).map((s) => s.text).filter((t, i, all) => t !== all[i - 1])
    assert.deepEqual(steps.slice(0, 3), ['Waiting for the AI…', 'Writing…', 'Drafting Scope notes · Body…'], steps.join(' | '))
    const counts = seen.filter((s) => s?.activity === 'waiting').map((s) => Number.parseInt(s.detail, 10))
    assert.ok(Math.max(...counts) >= counts[0] + 2, `the seconds go up: ${counts.join(',')}`)
    // Through the pause after the sentence, while the AI's message is still marked as arriving, the line said Writing.
    assert.ok(seen.filter((s) => s?.activity === 'writing').length > 10, 'Writing stayed up through the pause')
  })
})

test('a model that refuses the temperature setting: the line says it is trying again without it, and after a reload the next call leaves it out', async () => {
  await withTrio({ firstByteMs: 1500, pauseMs: 200, refuseTemperature: true }, async ({ open, base, ai }) => {
    const page = await open({ temperature: 0.3 })
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-status"][data-activity="retrying"]')
    assert.equal(await page.textContent('[data-testid="interview-status-text"]'), 'Trying again without the temperature setting…')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    await page.waitForSelector('[data-testid="interview-status"]', { state: 'detached' })
    assert.equal(ai.refusals.length, 1, 'refused once')
    const stored = await page.evaluate(() => localStorage.getItem('gantry:ai-refuses-sampling'))
    assert.ok(!stored.includes('key-one'), 'no key is stored with it')

    await page.reload()
    const before = ai.posts.length
    await page.waitForSelector('[data-testid="interview-chat"]:not([disabled])')
    await page.fill('[data-testid="interview-chat"]', 'One more thing: the budget is capped.')
    await page.click('[data-testid="interview-send"]')
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="interview-msg"][data-who="ai"]').length >= n, 2)
    await page.waitForSelector('[data-testid="interview-status"]', { state: 'detached' })
    assert.ok(ai.posts.length > before, 'the chat made a call')
    assert.ok(ai.posts.slice(before).every((p) => p.temperature === undefined), 'no temperature after the reload')
    assert.equal(ai.refusals.length, 1, 'and no second 400')
    const settings = await page.evaluate(() => JSON.parse(localStorage.getItem('gantry:ai-providers'))[0].temperature)
    assert.equal(settings, 0.3, "the architect's setting is not changed")
  })
})

test('Start this stage over confirms beside its button with the focus on it, and the kickoff then says Start interview, not Resume interview', async () => {
  await withTrio({ firstByteMs: 200, pauseMs: 100 }, async ({ open, base }) => {
    const first = await open()
    await first.goto(`${base}/instance/${SLUG}?interview=1`)
    await first.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    await first.click('[data-testid="interview-start"]')
    await first.waitForSelector('[data-testid="interview-stage-end"]')
    await first.click('[data-testid="interview-pause"]')
    await first.waitForSelector('[data-testid="interview-paused"]')
    await first.close()

    // A fresh browser resumes from the decisions log the Pause saved.
    const page = await open()
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-resume-recap"]')
    await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    assert.equal((await page.textContent('[data-testid="interview-start"]')).trim(), 'Resume interview')
    await page.click('[data-testid="interview-start"]')
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="interview-msg"][data-who="ai"]')].some((m) => /Carrying on/.test(m.textContent)))
    await page.waitForSelector('[data-testid="interview-status"]', { state: 'detached' })

    await page.click('[data-testid="interview-restart"]')
    await page.waitForSelector('[data-testid="interview-restart-confirm"]')
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'interview-restart-yes', 'the question has the focus')
    await page.keyboard.press('Enter')
    await page.waitForSelector('[data-testid="interview-start"]')
    assert.equal((await page.textContent('[data-testid="interview-start"]')).trim(), 'Start interview')
    assert.equal(await page.locator('[data-testid="interview-resume-recap"]').count(), 0, 'no recap: it starts afresh')
  })
})

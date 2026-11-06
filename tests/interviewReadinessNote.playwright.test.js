import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'
import { writeTrio } from './helpers/trioDefinition.js'

// #349: the AI is told what keeps a Stage from its stage-end card, and fixes what it can. A real server and relay, a real Chromium page
// and a stand-in for Anthropic on the three-Stage trio, whose Scope Field here has a word budget (about 24 to 40 words at the default
// size). The stand-in drafts it far too short and says it is done; the next request of the same turn carries Gantry's note, and the
// stand-in redrafts it at full length, slowly enough that the status line can be seen drafting. Then the stage-end card appears. What the
// session sends when is covered under node --test in tests/interviewReadinessNote.test.js; this is the screen.

const SLUG = 'readiness-note-test'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const words = (n) => Array.from({ length: n }, (_, i) => `word${String.fromCharCode(97 + (i % 26))}`).join(' ')
const NOTE = "Gantry's check: the Stage is not ready yet"

// The text of the last user turn of an Anthropic request.
function lastUserText(body) {
  const m = body.messages.filter((x) => x.role === 'user').at(-1)
  return typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}

function withShortDraftingAi(fn) {
  const posts = []
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
      const n = posts.length - 1
      const noted = lastUserText(body).startsWith(NOTE)
      const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      event('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } })
      const draft = async (id, value, slow = false) => {
        event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name: 'draft_field', input: {} } })
        event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"field":"m1.body",' } })
        if (slow) await wait(1500)
        event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: `"value":${JSON.stringify(value)}}` } })
        event('content_block_stop', { type: 'content_block_stop', index: 0 })
      }
      const say = (text) => {
        event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
        event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
        event('content_block_stop', { type: 'content_block_stop', index: 0 })
      }
      let stop = 'end_turn'
      if (n === 0) {
        await draft('d0', words(5))
        stop = 'tool_use'
      } else if (noted) {
        await draft('d1', words(30), true)
        stop = 'tool_use'
      } else say(n === 1 ? 'Scope is drafted.' : 'Scope is at full length now.')
      event('message_delta', { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 5 } })
      event('message_stop', { type: 'message_stop' })
      res.end()
    })
  })
  return new Promise((resolve, reject) => {
    upstream.listen(0, '127.0.0.1', async () => {
      try {
        await fn(`http://127.0.0.1:${upstream.address().port}`, { posts })
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        upstream.close()
      }
    })
  })
}

const seed = (page, aiBase) => {
  const passed = { status: 'passed', testedAt: '2026-11-02T00:00:00Z', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }
  const list = [{ id: 'one', name: 'First AI', type: 'anthropic', address: aiBase, key: 'key-one', model: 'claude-small', isDefault: true, test: passed }]
  return page.addInitScript((value) => localStorage.setItem('gantry:ai-providers', value), JSON.stringify(list))
}

test('a Field drafted under its word budget: the AI is told in the same turn, redrafts it with the status line drafting, and the stage-end card appears', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gantry-349-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  const browser = await launchBrowser()
  const pageErrors = []
  try {
    writeTrio(definitionsDir)
    // Scope's one Field gets a word budget, so a short draft is not done.
    writeFileSync(join(definitionsDir, 'trio', '1', 'modules', 'm1.yaml'), 'id: m1\ntitle: Scope notes\nfields:\n  - id: body\n    title: Body\n    type: markdown\n    required: true\n    target-words: { small: 10, medium: 40, large: 80 }\n')
    mkdirSync(instancesDir)
    createInstance('trio', SLUG, { instancesDir, definitionsDir, definitionVersion: 1 })
    await withShortDraftingAi((aiBase, ai) =>
      withRunningServer({ slug: SLUG, instancesDir, definitionsDir, allowPrivateAiUrls: true }, async (base) => {
        const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
        const page = await context.newPage()
        page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
        page.on('pageerror', (err) => pageErrors.push(err.message))
        await seed(page, aiBase)
        await page.goto(`${base}/instance/${SLUG}?interview=1`)
        await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
        await page.click('[data-testid="interview-start"]')

        // The redraft after the note shows on the status line as any draft does.
        await page.waitForSelector('[data-testid="interview-status"][data-activity="drafting"]')
        assert.equal(await page.textContent('[data-testid="interview-status-text"]'), 'Drafting Scope notes · Body…')
        assert.equal(ai.posts.length, 3)
        const note = lastUserText(ai.posts[2])
        assert.ok(note.startsWith(NOTE), note)
        assert.match(note, /- Scope notes · Body \(m1\.body\): 5 words, needs about 24 to 40/)

        // Then the Stage is ready, and the card appears once the turn has ended.
        await page.waitForSelector('[data-testid="interview-stage-end"]')
        assert.equal(await page.getAttribute('[data-testid="interview-field-done"]', 'data-done'), 'true')
        assert.equal(ai.posts.length, 4, 'one note, and the AI carried on in the same turn')
        const ai_ = await page.$$eval('[data-testid="interview-msg"][data-who="ai"]', (els) => els.map((e) => e.textContent.trim()))
        assert.deepEqual(ai_, ['Scope is drafted.', 'Scope is at full length now.'])
        const all = await page.$$eval('[data-testid="interview-msg"]', (els) => els.map((e) => e.textContent))
        assert.ok(!all.some((t) => t.includes(NOTE)), 'the note is for the AI, not a line in the thread')
        assert.equal(await page.$('[data-testid="interview-carry-on"]'), null)
      })
    )
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
    rmSync(root, { recursive: true, force: true })
  }
})

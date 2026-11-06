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

// #344 (parent #343): a reply cut off at the AI Provider's output limit is recovered, not dropped. A real server and relay, a real Chromium
// page and a stand-in AI Provider on the three-Stage trio, speaking Anthropic's wire format (stopping with `max_tokens`) or an
// OpenAI-compatible one (finishing with `length`). Its first reply is cut off part-way through drafting Scope's one Field; the next request
// takes its time, so the status line can be seen asking for a shorter reply. What the session says when is covered under node --test in
// tests/interviewCutOff.test.js; this is the screen.

const SLUG = 'cut-off-test'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// `cuts`: how many replies in a row are cut off before one drafts the Field whole. Every request after that answers with a sentence.
function withCuttingAi({ wire = 'anthropic', cuts = 1, delayMs = 1500 } = {}, fn) {
  const posts = []
  const upstream = createHttpServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', async () => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'small-model', max_input_tokens: 200000 }] }))
        return
      }
      const body = JSON.parse(raw)
      posts.push(body)
      const n = posts.length - 1
      if (n > 0) await wait(delayMs)
      const cut = n < cuts
      const draft = n === cuts
      const text = n === 0 ? 'Drafting Scope from the deck.' : n > cuts ? 'Scope is drafted.' : ''
      const args = cut ? '{"field":"m1.body","value":"Notes for s1: a very long dra' : '{"field":"m1.body","value":"Notes for s1: the agreed position, in short."}'
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (wire === 'anthropic') {
        const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
        event('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } })
        let index = 0
        if (text) {
          event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
          event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } })
          event('content_block_stop', { type: 'content_block_stop', index: index++ })
        }
        if (cut || draft) {
          event('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `d${n}`, name: 'draft_field', input: {} } })
          event('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: args } })
          event('content_block_stop', { type: 'content_block_stop', index })
        }
        event('message_delta', { type: 'message_delta', delta: { stop_reason: cut ? 'max_tokens' : draft ? 'tool_use' : 'end_turn' }, usage: { output_tokens: cut ? 4096 : 5 } })
        event('message_stop', { type: 'message_stop' })
      } else {
        const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
        if (text) chunk({ content: text })
        if (cut || draft) chunk({ tool_calls: [{ index: 0, id: `call_${n}`, function: { name: 'draft_field', arguments: args } }] })
        chunk({}, cut ? 'length' : draft ? 'tool_calls' : 'stop')
        res.write('data: [DONE]\n\n')
      }
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

// One tested, Default AI Provider pointing at the stand-in.
const seed = (page, aiBase, wire) => {
  const passed = { status: 'passed', testedAt: '2026-11-02T00:00:00Z', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }
  const provider =
    wire === 'anthropic'
      ? { id: 'one', name: 'First AI', type: 'anthropic', address: aiBase, key: 'key-one', model: 'small-model', isDefault: true, test: passed }
      : { id: 'one', name: 'First AI', type: 'custom', address: `${aiBase}/v1`, key: 'key-one', model: 'small-model', isDefault: true, test: passed }
  return page.addInitScript((value) => localStorage.setItem('gantry:ai-providers', value), JSON.stringify([provider]))
}

async function withTrio(options, fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-344-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  const browser = await launchBrowser()
  const pageErrors = []
  try {
    writeTrio(definitionsDir)
    mkdirSync(instancesDir)
    createInstance('trio', SLUG, { instancesDir, definitionsDir, definitionVersion: 1 })
    await withCuttingAi(options, (aiBase, ai) =>
      withRunningServer({ slug: SLUG, instancesDir, definitionsDir, allowPrivateAiUrls: true }, async (base) => {
        const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
        const page = await context.newPage()
        page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
        page.on('pageerror', (err) => pageErrors.push(err.message))
        await seed(page, aiBase, options.wire ?? 'anthropic')
        await page.goto(`${base}/instance/${SLUG}?interview=1`)
        await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
        await page.click('[data-testid="interview-start"]')
        await fn({ page, ai })
      })
    )
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
    rmSync(root, { recursive: true, force: true })
  }
}

// What the next request said back about the cut-off call, from either wire format.
function resultFor(body, id) {
  for (const m of body.messages) {
    if (m.role === 'tool' && m.tool_call_id === id) return m.content
    for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === 'tool_result' && b.tool_use_id === id) return b.content
  }
  return null
}

const systemLines = (page) => page.$$eval('[data-testid="interview-msg"][data-who="sys"]', (els) => els.map((e) => e.textContent))

for (const [wire, id] of [
  ['anthropic', 'd0'],
  ['openai-compatible', 'call_0'],
]) {
  test(`${wire}: a reply cut off part-way through a draft says so on the status line, and the interview goes on to the draft`, async () => {
    await withTrio({ wire }, async ({ page, ai }) => {
      await page.waitForSelector('[data-testid="interview-status"][data-activity="cut-off"]')
      assert.equal(await page.textContent('[data-testid="interview-status-text"]'), 'Reply cut off at the output limit. Asking for a shorter one…')
      await page.waitForSelector('[data-testid="interview-stage-end"]')
      await page.waitForSelector('[data-testid="interview-status"]', { state: 'detached' })
      const told = resultFor(ai.posts[1], id)
      assert.match(told, /output limit/)
      assert.doesNotMatch(told, /not valid JSON/)
      const ai1 = await page.$$eval('[data-testid="interview-msg"][data-who="ai"]', (els) => els.map((e) => e.textContent))
      assert.ok(ai1.includes('Drafting Scope from the deck.'), 'the text before the cut-off stays in the thread')
      assert.ok(!(await systemLines(page)).some((t) => /Max tokens/.test(t)), 'one cut-off says nothing in the thread')
    })
  })
}

test('two cut-offs in a row: the thread says once that Max tokens on Global Settings is the fix, and the interview still carries on', async () => {
  await withTrio({ cuts: 2, delayMs: 300 }, async ({ page }) => {
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    const said = (await systemLines(page)).filter((t) => /Max tokens/.test(t))
    assert.equal(said.length, 1)
    assert.equal(said[0], "The AI's reply was cut off at the output limit again. To give it more room, raise Max tokens for First AI under AI Providers on Global Settings.")
  })
})

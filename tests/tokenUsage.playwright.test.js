import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'
import { systemText } from './helpers/aiRequest.js'

// #294 (parent #238): the architect sees token usage, and prompt caching is always on. A real server and relay, a real Chromium page,
// and a stand-in for Anthropic that reports its tokens (most of the input read from the cache) while it drafts the one Field each
// Stage of a small three-Stage Definition needs. Tokens only, never money.

const SLUG = 'tokens-test'

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
    page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await fn(page, pageErrors)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

// ---------- a three-Stage Definition ----------
// Each Stage has one Module with one required Field, and one Artefact that the Stage's Gate asks for.
function writeTrio(definitionsDir) {
  const dir = join(definitionsDir, 'trio', '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  const stages = [
    ['s1', 'Scope', 'g1', 'm1'],
    ['s2', 'Shape', 'g2', 'm2'],
    ['s3', 'Ship', 'g3', 'm3'],
  ]
  writeFileSync(
    join(dir, 'definition.yaml'),
    [
      'id: trio',
      'version: 1',
      'status: published',
      'title: Trio',
      'stages:',
      ...stages.flatMap(([id, title, gate, mod]) => [`  - id: ${id}`, `    title: ${title}`, `    purpose: PURPOSE-${id}`, `    gate: ${gate}`, `    modules: [${mod}]`]),
      'artefacts:',
      ...stages.flatMap(([id, title, gate, mod]) => [`  - id: art-${id}`, `    title: ${title} document`, `    template: templates/${id}.md.tmpl`, `    gate: ${gate}`, `    requires: [${mod}.body]`]),
      '',
    ].join('\n')
  )
  for (const [id, title, , mod] of stages) {
    writeFileSync(join(dir, 'modules', `${mod}.yaml`), `id: ${mod}\ntitle: ${title} notes\nfields:\n  - id: body\n    title: Body\n    type: markdown\n    required: true\n`)
    writeFileSync(join(dir, 'templates', `${id}.md.tmpl`), `# ${title}\n\n{{${mod}.body}}\n`)
  }
}

// ---------- the stand-in AI Provider ----------
const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')

function anthropicReply({ text, tools = [] }) {
  const events = [['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 1000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 0, output_tokens: 1 } } }]]
  let index = 0
  if (text) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }])
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  for (const tool of tools) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: 'draft_field', input: {} } }])
    const json = JSON.stringify(tool.input)
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 11) } }])
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(11) } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 50 } }])
  events.push(['message_stop', { type: 'message_stop' }])
  return sse(events)
}

// Which Stage the AI is being asked about: the brief carries that Stage's purpose.
const stageOf = (body) => ['s1', 's2', 's3'].find((id) => JSON.stringify(body.system ?? '').includes(`PURPOSE-${id}`))
const MODULE = { s1: 'm1', s2: 'm2', s3: 'm3' }

// The first turn of a Stage drafts its one Field; the turn after the draft result is a short reply.
const runScript = (body) => {
  const stage = stageOf(body)
  if (body.messages.length === 1) return { text: `Reading for ${stage}.`, tools: [{ id: `d-${stage}`, input: { field: `${MODULE[stage]}.body`, value: `Notes for ${stage}: the agreed position, written out.` } }] }
  return { text: `${stage} is drafted.` }
}

function withFakeAnthropic(script, fn) {
  const posts = []
  const upstream = createHttpServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'claude-small', max_input_tokens: 200000 }] }))
        return
      }
      posts.push({ key: req.headers['x-api-key'] ?? null, raw, body: JSON.parse(raw) })
      const reply = anthropicReply(script(JSON.parse(raw), posts.length - 1))
      // A short pause, so a Stage is seen to be "drafting" before its card appears.
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.end(reply)
      }, 400)
    })
  })
  return new Promise((resolve, reject) => {
    upstream.listen(0, '127.0.0.1', async () => {
      try {
        await fn(`http://127.0.0.1:${upstream.address().port}`, posts)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        upstream.close()
      }
    })
  })
}

function seedProviders(page, aiBase) {
  const passed = { status: 'passed', testedAt: '2026-11-02T00:00:00Z', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }
  const list = [{ id: 'one', name: 'First AI', type: 'anthropic', address: aiBase, key: 'key-one', model: 'claude-small', isDefault: true, test: passed }]
  return page.addInitScript((value) => localStorage.setItem('gantry:ai-providers', value), JSON.stringify(list))
}

async function withTrioServer(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-294-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  try {
    writeTrio(definitionsDir)
    mkdirSync(instancesDir)
    createInstance('trio', SLUG, { instancesDir, definitionsDir, definitionVersion: 1 })
    await withFakeAnthropic(runScript, (aiBase, posts) =>
      withRunningServer({ slug: SLUG, instancesDir, definitionsDir, allowPrivateAiUrls: true }, (base) =>
        withPage(async (page) => {
          await seedProviders(page, aiBase)
          await fn({ page, base, posts, instancesDir })
        })
      )
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const row = (page, id) => page.locator(`[data-testid="run-plan-row"][data-stage-id="${id}"]`)
const waitState = (page, id, state) => page.waitForSelector(`[data-testid="run-plan-row"][data-stage-id="${id}"][data-state="${state}"]`)

function instanceFolder(instancesDir) {
  for (const candidate of [join(instancesDir, 'default', SLUG), join(instancesDir, SLUG)]) if (existsSync(join(candidate, 'instance.yaml'))) return candidate
  throw new Error('no instance folder')
}
const readYaml = (file) => parseYAML(readFileSync(file, 'utf8'))

// Each Stage takes two requests (draft the Field, then say so), each reporting 1,000 input tokens plus 8,000 read from the cache and
// 50 output tokens: 18,000 input (16,000 cached, 89%) and 100 output a Stage.
const PER_STAGE = { input: 18000, cached: 16000, output: 100 }

test('the rail and the run plan show tokens only, with the share read from cache on hover; the log keeps them per model and a reload keeps the totals', async () => {
  await withTrioServer(async ({ page, base, posts, instancesDir }) => {
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-run-until"]')
    assert.equal(await page.locator('[data-testid="interview-tokens"]').count(), 0, 'nothing to show before the AI has said anything')
    await page.selectOption('[data-testid="interview-run-until"]', 's2')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')

    // Shape one Stage in: the session total and this Stage's total, in words, the same here as there.
    assert.equal((await page.textContent('[data-testid="interview-tokens-session"]')).trim(), '18k tokens')
    assert.equal((await page.textContent('[data-testid="interview-tokens-stage"]')).trim(), '18k tokens')
    const hover = await page.getAttribute('[data-testid="interview-tokens-stage"]', 'title')
    assert.equal(hover, 'Input 18,000 tokens, cached 16,000, output 100. 89% of input read from cache.')
    assert.equal((await row(page, 's1').locator('[data-testid="run-plan-tokens"]').textContent()).trim(), '18k tokens')
    assert.equal(await row(page, 's2').locator('[data-testid="run-plan-tokens"]').count(), 0, 'a Stage not reached has used nothing')
    assert.match(await row(page, 's1').locator('[data-testid="run-plan-tokens"]').getAttribute('title'), /89% of input read from cache/)

    // No money anywhere on the page's rail, and nothing per round.
    assert.doesNotMatch(await page.textContent('.interview-rail'), /[$£€]|\bcost\b|\bbudget\b|\bUSD\b/i)

    // Save, advance, carry on: Shape starts by itself, the session total adds both Stages, this Stage's total is its own.
    await page.click('[data-testid="interview-save-advance"]')
    await page.waitForSelector('[data-testid="interview-field"][data-field-key="m2.body"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    assert.equal((await page.textContent('[data-testid="interview-tokens-session"]')).trim(), '36k tokens')
    assert.equal((await page.textContent('[data-testid="interview-tokens-stage"]')).trim(), '18k tokens')
    assert.equal((await row(page, 's1').locator('[data-testid="run-plan-tokens"]').textContent()).trim(), '18k tokens', "Scope's total comes from its committed log")
    assert.equal((await row(page, 's2').locator('[data-testid="run-plan-tokens"]').textContent()).trim(), '18k tokens')
    await page.click('[data-testid="interview-save"]')
    await page.waitForSelector('[data-testid="interview-run-done"]')

    // The status block keeps the model used on each Stage with its own input, cached and output tokens, and no money figure.
    const folder = instanceFolder(instancesDir)
    for (const stage of ['s1', 's2']) {
      const status = readYaml(join(folder, 'interview', `${stage}.yaml`)).status[0]
      assert.deepEqual(status.models, [{ type: 'anthropic', model: 'claude-small', inputTokens: PER_STAGE.input, cachedTokens: PER_STAGE.cached, outputTokens: PER_STAGE.output }])
    }
    assert.doesNotMatch(readFileSync(join(folder, 'interview', 's1.yaml'), 'utf8'), /[$£€]|cost|price/i)

    // Prompt caching is always on: every request carried a one-hour cache point after the Source documents and before what changes.
    assert.ok(posts.length >= 4)
    for (const post of posts) {
      assert.deepEqual(post.body.system[0].cache_control, { type: 'ephemeral', ttl: '1h' })
      assert.match(post.body.system[0].text, /## 8\. Source documents/)
      assert.doesNotMatch(post.body.system[0].text, /## 9\. Decisions log so far/)
      assert.match(systemText(post.body), /## 9\. Decisions log so far/)
    }

    // Another browser: nothing of the session is left in the tab, and the totals come from what was committed.
    await page.evaluate(() => sessionStorage.clear())
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="run-plan-row"]')
    await page.waitForSelector('[data-testid="run-plan-tokens"]')
    assert.deepEqual(await page.locator('[data-testid="run-plan-tokens"]').evaluateAll((els) => els.map((e) => e.textContent.trim())), ['18k tokens', '18k tokens'])
  })
})

test('a paused run that is resumed after a reload still adds up the Stages it already went through', async () => {
  await withTrioServer(async ({ page, base }) => {
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-run-until"]')
    await page.selectOption('[data-testid="interview-run-until"]', 's3')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    await page.click('[data-testid="interview-save-advance"]')
    await page.waitForSelector('[data-testid="interview-field"][data-field-key="m2.body"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    await page.click('[data-testid="interview-save"]')
    await page.waitForSelector('[data-testid="interview-run-paused"]')

    // A reload forgets the run held in the tab; the decisions logs say where it was. Resuming carries on into Ship.
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-resume-note"]')
    await page.click('[data-testid="interview-resume"]')
    await page.waitForSelector('[data-testid="interview-field"][data-field-key="m3.body"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    assert.equal((await page.textContent('[data-testid="interview-tokens-stage"]')).trim(), '18k tokens')
    assert.equal((await page.textContent('[data-testid="interview-tokens-session"]')).trim(), '54k tokens', 'Scope, Shape and Ship: the run, not only this visit')
    assert.equal(await page.locator('[data-testid="run-plan-tokens"]').count(), 3)
  })
})

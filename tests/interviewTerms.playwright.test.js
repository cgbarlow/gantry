import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'

// #291 (parent #238): term cards, Key decision cards and open questions on the Interview page. A real server and relay, a real
// Chromium page, and a stand-in for Anthropic that plays a scripted interview (as in tests/interviewCards.playwright.test.js).
// The bundled design v3 mounts Open questions on its first Stage (Shape) and Glossary and Key decisions on later ones, so a
// scratch copy that also mounts them on Shape plays "mounted", and the bundled one plays "not mounted".

const SLUG = 'my-initiative'

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

// ---------- the stand-in AI Provider ----------
const sse = (events) => events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join('')

function anthropicReply({ text, tools = [] }) {
  const events = [['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 1 } } }]]
  let index = 0
  if (text) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }])
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  for (const tool of tools) {
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: tool.name ?? 'draft_field', input: {} } }])
    const json = JSON.stringify(tool.input)
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 11) } }])
    events.push(['content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(11) } }])
    events.push(['content_block_stop', { type: 'content_block_stop', index }])
    index++
  }
  events.push(['message_delta', { type: 'message_delta', delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }])
  events.push(['message_stop', { type: 'message_stop' }])
  return sse(events)
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
      posts.push({ raw, body: JSON.parse(raw) })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(anthropicReply(script(JSON.parse(raw), posts.length - 1)))
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

const ask = (id, questions) => ({ id, name: 'ask_architect', input: { questions } })
const cardLocator = (page, id) => page.locator(`[data-testid="interview-card"][data-card-id="${id}"]`)
const termCard = () => ({
  id: 'term-claim',
  kind: 'term',
  question: 'The brief says "claim" and the minutes say "case". Which name should every document use?',
  options: [{ label: 'Claim', description: 'The brief’s word' }, { label: 'Case', description: 'The minutes’ word' }],
  recommended: 'Claim',
  why: 'The brief is the signed-off document.',
  meaning: 'A request by a member to be paid for a loss.',
})
const decisionCard = () => ({
  id: 'ledger',
  kind: 'decision',
  header: 'Ledger store',
  question: 'Where should the ledger live?',
  options: [{ label: 'PostgreSQL', description: 'The team knows it' }, { label: 'DynamoDB', description: 'Cloud-native' }],
  recommended: 'PostgreSQL',
  why: 'The team already runs it.',
  decision: { hardToReverse: 'Moving a ledger means migrating every record.', surprising: 'A reader would expect the cloud-native store.', tradeOff: 'Familiarity against scale-out.' },
})

/** A scratch copy of design v3 whose first Stage (Shape) also mounts the Glossary and Key decisions. */
async function withMountedDefinitions(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-291-defs-'))
  try {
    const definitionsDir = join(root, 'definitions')
    cpSync('definitions/design/3', join(definitionsDir, 'design', '3'), { recursive: true })
    const path = join(definitionsDir, 'design', '3', 'definition.yaml')
    const text = readFileSync(path, 'utf8')
    const edited = text.replace('modules: [background, introduction, design-basis, solution-definition, team-and-estimates, dependencies, soap-full-details, open-questions]', 'modules: [background, introduction, design-basis, solution-definition, team-and-estimates, dependencies, soap-full-details, open-questions, glossary, key-decisions]')
    assert.notEqual(edited, text, 'the Shape Stage line is where this test expects it')
    writeFileSync(path, edited)
    return await fn(definitionsDir)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

async function openInterview(page, base) {
  await page.goto(`${base}/instance/${SLUG}?interview=1`)
  await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
}

test('a term card and a Key decision card show what they settle, and the answers are logged and given back to the AI', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-291-'))
  try {
    await withMountedDefinitions(async (definitionsDir) => {
      createInstance('design', SLUG, { instancesDir, definitionsDir, definitionVersion: 3 })
      const script = (body, n) => (n === 0 ? { text: 'I read the brief.', tools: [ask('a1', [termCard(), decisionCard()])] } : { text: 'Noted.' })
      await withFakeAnthropic(script, (aiBase, posts) =>
        withRunningServer({ slug: SLUG, instancesDir, definitionsDir, allowPrivateAiUrls: true }, (base) =>
          withPage(async (page) => {
            await seedProviders(page, aiBase)
            await openInterview(page, base)
            await page.click('[data-testid="interview-start"]')
            await page.waitForSelector('[data-testid="interview-round"]')

            // The term card: its own chip, what the thing is, the names as options, and the Glossary it feeds.
            const term = cardLocator(page, 'term-claim')
            assert.equal(await term.getAttribute('data-card-kind'), 'term')
            assert.match(await term.locator('.qchip').textContent(), /Preferred term/)
            assert.match(await term.locator('[data-testid="card-feeds"]').textContent(), /Glossary/)
            assert.match(await term.locator('[data-testid="card-meaning"]').textContent(), /A request by a member to be paid for a loss\./)
            assert.equal(await term.locator('[data-testid="card-option"]').count(), 2)
            assert.equal(await term.locator('input[type="checkbox"]').count(), 0, 'one name only')
            assert.equal(await term.locator('[data-testid="card-other"]').count(), 1, 'the architect can give their own name')

            // The Key decision card: why it passed the three-part test, and the Key decisions it feeds.
            const decision = cardLocator(page, 'ledger')
            assert.equal(await decision.getAttribute('data-card-kind'), 'decision')
            assert.match(await decision.locator('.qchip').textContent(), /Ledger store/)
            assert.match(await decision.locator('[data-testid="card-feeds"]').textContent(), /Key decisions/)
            const why = await decision.locator('[data-testid="card-significance"]').textContent()
            assert.match(why, /Hard to reverse:\s*Moving a ledger means migrating every record\./)
            assert.match(why, /Surprising without context:\s*A reader would expect the cloud-native store\./)
            assert.match(why, /A real trade-off:\s*Familiarity against scale-out\./)

            await term.locator('[data-testid="card-option"][data-option="Case"]').click()
            await page.click('[data-testid="round-submit"]')
            await page.waitForFunction(() => !document.querySelector('[data-testid="interview-round"]'))

            // What the AI is told: the term choice, and that the decision is to be drafted as a Key decision.
            const answers = posts[1].body.messages.at(-1).content.find((b) => b.type === 'tool_result' && b.tool_use_id === 'a1').content
            assert.match(answers, /Term choice, logged: prefer "Case", avoid "Claim"/)
            assert.match(answers, /Key decision, logged\. Draft it into the Key decisions Field as the next numbered decision/)
            // The brief on that turn gives the choice as a name to use, and rows to draft the Glossary from.
            assert.match(posts[1].body.system, /Use "Case", not "Claim"/)
            assert.match(posts[1].body.system, /\| Case \| A request by a member to be paid for a loss\. \| Claim \|/)

            // The rail counts both answers, and the Key decision is flagged in the history of the log.
            assert.match(await page.textContent('[data-testid="interview-decisions-count"]'), /^2$/)
          })
        )
      )
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('where Key decisions and the Glossary are not mounted, a decision card is an ordinary question and the choice is only in the log', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-291-'))
  try {
    createInstance('design', SLUG, { instancesDir, definitionVersion: 3 })
    const script = (body, n) => (n === 0 ? { text: 'I read the brief.', tools: [ask('a1', [termCard(), decisionCard()])] } : { text: 'Noted.' })
    await withFakeAnthropic(script, (aiBase, posts) =>
      withRunningServer({ slug: SLUG, instancesDir, allowPrivateAiUrls: true }, (base) =>
        withPage(async (page) => {
          await seedProviders(page, aiBase)
          await openInterview(page, base)
          await page.click('[data-testid="interview-start"]')
          await page.waitForSelector('[data-testid="interview-round"]')

          const decision = cardLocator(page, 'ledger')
          assert.equal(await decision.getAttribute('data-card-kind'), '', 'a routine answer is not offered as a Key decision')
          assert.equal(await decision.locator('[data-testid="card-significance"]').count(), 0)
          assert.equal(await decision.locator('[data-testid="card-feeds"]').count(), 0)
          const term = cardLocator(page, 'term-claim')
          assert.equal(await term.getAttribute('data-card-kind'), 'term', 'a term is still settled')
          assert.equal(await term.locator('[data-testid="card-feeds"]').count(), 0, 'no Glossary to feed')

          await page.click('[data-testid="round-submit"]')
          await page.waitForFunction(() => !document.querySelector('[data-testid="interview-round"]'))
          assert.match(posts[1].body.system, /Use "Claim", not "Case"/)
          assert.match(posts[1].body.system, /The Glossary is not drafted on this Stage, so the choices stay in the decisions log only/)
          assert.match(posts[1].body.system, /Key decisions is not mounted on this Stage\. Do not offer a Key decision/)
          assert.match(posts[1].body.system, /Open questions\*\* is mounted \(`open-questions\.questions`\)/)
        })
      )
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

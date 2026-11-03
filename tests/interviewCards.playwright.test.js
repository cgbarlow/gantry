import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'

// #287 (parent #238): rounds of question cards on the Interview page, end to end. A real server and relay, a real Chromium
// page, and a stand-in for Anthropic that plays a scripted interview (see tests/interviewPage.playwright.test.js for the
// drafting side). The stand-in records every request so the tests can say what the AI was sent.

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

// ---------- scripted drafts ----------
// A Field is done only at about 60% of its word budget (#287), so the scripted drafts are the length of a real draft.
const fill = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')
const CITE = '[Client brief, p. 1](source:client-brief)'
const draft = (id, field, value) => ({ id, input: { field, value } })
const SOAP_DRAFTS = [
  draft('t1', 'background.problem', `Claims take too long to settle ${CITE}. ${fill(90)}.`),
  draft('t2', 'background.affected-domains', ['Claims', 'Member services', fill(18)]),
  draft('t3', 'solution-definition.high-level-requirements', `Members must lodge claims online ${CITE}. ${fill(110)}.`),
  draft('t4', 'solution-definition.high-level-solution-overview', `Configure the existing claims platform. ${fill(65)}.`),
  draft('t5', 'solution-definition.process-flow', `A member lodges, an assessor reviews, payment is made. ${fill(70)}.`),
  draft('t6', 'solution-definition.feature-breakdown', `Lodge a claim. Track its status. ${fill(70)}.`),
  draft('t7', 'team-and-estimates.teams-required', ['Claims', 'Integration', fill(60)]),
]
const ESTIMATE_RAW = `Delivery takes 12 weeks. ${fill(70)}.`
const ESTIMATE_MARKED = `Delivery takes 12 weeks (target assumption). ${fill(70)}.`

const ask = (id, questions) => ({ id, name: 'ask_architect', input: { questions } })
const qcard = (id, over = {}) => ({
  id,
  header: `Topic ${id}`,
  question: `Question ${id}?`,
  options: [{ label: `${id} yes`, description: 'Say yes' }, { label: `${id} no`, description: 'Say no' }],
  recommended: `${id} yes`,
  why: `Because ${id}.`,
  ...over,
})
const field = (page, key) => page.locator(`[data-testid="interview-field"][data-field-key="${key}"]`)
const cardLocator = (page, id) => page.locator(`[data-testid="interview-card"][data-card-id="${id}"]`)
const roundText = (page) => page.textContent('[data-testid="round-head"]')
const cardIds = (page) => page.locator('[data-testid="interview-card"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-card-id')))

async function openInterview(page, base) {
  await page.goto(`${base}/instance/${SLUG}?interview=1`)
  await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
}

async function addBrief(base) {
  await fetch(`${base}/api/instance/sources?slug=${SLUG}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'Client brief.md', dataBase64: Buffer.from('# Client brief\n\nClaims take too long.').toString('base64'), text: '# Client brief\n\nClaims take too long.' }),
  })
}

test('a round of six cards pages four at a time, submits together, a held card follows, and the stage-end card waits for the cards', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-287-'))
  try {
    createInstance('design', SLUG, { instancesDir, definitionVersion: 3 })
    const round = [
      qcard('c1', { field: 'background.problem', source: { document: 'client-brief', location: 'p. 3' } }),
      qcard('c2', { multiSelect: true, recommended: ['c2 yes', 'c2 no'], header: 'Domains' }),
      qcard('c3'),
      qcard('c4', { kind: 'missing' }),
      qcard('c5'),
      qcard('c6', { kind: 'disagreement' }),
      qcard('c7', { after: ['c1'] }),
    ]
    const script = (body, n) => (n === 0 ? { text: 'I read the brief.', tools: [...SOAP_DRAFTS, draft('t8', 'team-and-estimates.estimates', ESTIMATE_MARKED), ask('a1', round)] } : { text: 'Thanks, noted.' })
    await withFakeAnthropic(script, (aiBase, posts) =>
      withRunningServer({ slug: SLUG, instancesDir, allowPrivateAiUrls: true }, (base) =>
        withPage(async (page) => {
          await seedProviders(page, aiBase)
          await addBrief(base)
          await openInterview(page, base)
          assert.match(await page.textContent('[data-testid="interview-card-mode"]'), /Question cards:\s*native/)
          await page.click('[data-testid="interview-start"]')
          await page.waitForSelector('[data-testid="interview-round"]')

          // Seven cards were asked; the one that comes after c1 is held, so the round is six: four, then two.
          assert.match(await roundText(page), /Round 1 · 6 questions · cards 1–4 of 6/)
          assert.equal(await page.locator('[data-testid="interview-card"]').count(), 4)
          assert.match(await page.textContent('[data-testid="round-held"]'), /1 more question will follow/)
          // Gantry's order: the Field this Gate requires first, then the disagreement, then the missing fact, then the rest.
          assert.deepEqual(await cardIds(page), ['c1', 'c6', 'c4', 'c2'])

          // The card: chip with the Field it feeds, option tiles with the recommendation pre-selected and badged, why + cited source, Other.
          const c1 = cardLocator(page, 'c1')
          assert.match(await c1.locator('.qchip').textContent(), /Topic c1/)
          assert.match(await c1.locator('[data-testid="card-feeds"]').textContent(), /Problem/i)
          assert.equal(await c1.locator('[data-testid="card-option"][data-option="c1 yes"]').getAttribute('data-chosen'), 'true')
          assert.equal(await c1.locator('[data-testid="card-option"][data-option="c1 yes"] [data-testid="card-recommended"]').textContent(), 'RECOMMENDED')
          assert.equal(await c1.locator('[data-testid="card-option"][data-option="c1 no"]').getAttribute('data-chosen'), 'false')
          assert.match(await c1.locator('[data-testid="card-why"]').textContent(), /Why I recommend it:\s*Because c1\./)
          assert.match(await c1.locator('[data-testid="card-cite"]').textContent(), /Client brief, p\. 3/)
          assert.equal(await c1.locator('[data-testid="card-other"]').count(), 1)
          assert.equal(await cardLocator(page, 'c2').locator('input[type="checkbox"]').count(), 3, '"choose any": two options and Other as checkboxes')
          assert.match(await cardLocator(page, 'c2').locator('.qchip').textContent(), /choose any/)

          // No stage-end card while cards are open, even though every Field is done; Submit is on the last page.
          assert.equal(await page.locator('[data-testid="interview-stage-end"]').count(), 0)
          assert.equal(await page.locator('[data-testid="round-submit"]').count(), 0)

          // Page two, then back again; the choices are kept.
          await c1.locator('[data-testid="card-option"][data-option="c1 no"]').click()
          await page.click('[data-testid="round-next"]')
          assert.match(await roundText(page), /cards 5–6 of 6/)
          assert.deepEqual(await cardIds(page), ['c3', 'c5'])
          await page.click('[data-testid="round-back"]')
          assert.equal(await cardLocator(page, 'c1').locator('[data-testid="card-option"][data-option="c1 no"]').getAttribute('data-chosen'), 'true')
          await page.click('[data-testid="round-next"]')

          // Other opens a free-text box; an empty one is not an answer.
          const c5 = cardLocator(page, 'c5')
          await c5.locator('[data-testid="card-other"] input[type="radio"]').check()
          assert.equal(await page.isDisabled('[data-testid="round-submit"]'), true)
          assert.match(await page.textContent('[data-testid="round-unanswered"]'), /1 still to answer/)
          await c5.locator('[data-testid="card-other-input"]').fill('Our own plan')
          assert.equal(await page.isDisabled('[data-testid="round-submit"]'), false)
          await page.click('[data-testid="round-submit"]')

          // Everything went together as the one result of the one ask_architect call.
          await page.waitForFunction(() => document.querySelector('[data-testid="interview-round"]')?.getAttribute('data-round') === '2')
          const answers = posts[1].body.messages.at(-1).content.find((b) => b.type === 'tool_result' && b.tool_use_id === 'a1').content
          assert.match(answers, /all 6 cards of round 1/)
          assert.match(answers, /\[c1\] Question c1\? → "c1 no" \(not your recommendation\)\. Feeds background\.problem\./)
          assert.match(answers, /\[c5\] Question c5\? → Other, in the architect's own words: "Our own plan"/)
          assert.match(answers, /\[c2\] Question c2\? → "c2 yes" and "c2 no" \(your recommendation\)/)

          // The held card is shown by itself now its prerequisite is answered.
          assert.match(await roundText(page), /Round 2 · 1 question/)
          assert.deepEqual(await cardIds(page), ['c7'])
          assert.equal(await page.locator('[data-testid="round-next"]').count(), 0, 'one page, no Next')
          assert.equal(await page.locator('[data-testid="interview-stage-end"]').count(), 0)
          await page.click('[data-testid="round-submit"]')

          // All cards answered, the Gate passes and every Field is done: the stage-end card appears.
          await page.waitForSelector('[data-testid="interview-stage-end"]')
          assert.equal(await page.locator('[data-testid="interview-round"]').count(), 0)
          assert.match(await field(page, 'background.problem').locator('[data-testid="interview-field-done"]').textContent(), /Done/)
        })
      )
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('the stage-end card needs every Field in scope to be done, not only the Gate check', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-287-'))
  try {
    createInstance('design', SLUG, { instancesDir, definitionVersion: 3 })
    // Every required Field has something, so the Gate check passes, but the problem statement is far short of its budget.
    const drafts = SOAP_DRAFTS.map((d) => (d.id === 't1' ? draft('t1', 'background.problem', 'Claims take too long.') : d)).concat(draft('t8', 'team-and-estimates.estimates', ESTIMATE_MARKED))
    await withFakeAnthropic(
      (body, n) => (n === 0 ? { text: 'Drafted.', tools: drafts } : { text: 'Noted.' }),
      (aiBase) =>
        withRunningServer({ slug: SLUG, instancesDir, allowPrivateAiUrls: true }, (base) =>
          withPage(async (page) => {
            await seedProviders(page, aiBase)
            await openInterview(page, base)
            await page.click('[data-testid="interview-start"]')
            await field(page, 'team-and-estimates.estimates').locator('[data-testid="interview-field-done"]').waitFor()
            await page.waitForFunction(() => !document.querySelector('[data-testid="interview-working"]'))
            assert.match(await page.textContent('[data-testid="interview-gate-line"]'), /Gate check \(.*\): passes/)
            const status = field(page, 'background.problem').locator('[data-testid="interview-field-done"]')
            assert.equal(await status.getAttribute('data-done'), 'false')
            assert.match(await status.textContent(), /needs about 78 to 130/)
            assert.equal(await page.locator('[data-testid="interview-stage-end"]').count(), 0)
            assert.match(await page.textContent('[data-testid="interview-gate-line"]'), /7 of 8 Fields in scope done/)
          })
        )
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('Finish with your recommendations accepts the open cards, marks proposed figures, asks one last round, and the stage-end card waits for it', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-287-'))
  try {
    createInstance('design', SLUG, { instancesDir, definitionVersion: 3 })
    const script = (body, n) => {
      if (n === 0) return { text: 'Reading.', tools: [...SOAP_DRAFTS, ask('a1', [qcard('k1', { field: 'team-and-estimates.estimates' }), qcard('k2')])] }
      if (n === 1) {
        return {
          text: 'Taking your recommendations.',
          tools: [draft('t9', 'team-and-estimates.estimates', ESTIMATE_RAW), ask('a2', [qcard('owner', { question: 'Who is the named Owner?', options: [{ label: 'Leave it blank' }, { label: 'Name them' }], recommended: 'Leave it blank' })])],
        }
      }
      return { text: 'All set.' }
    }
    await withFakeAnthropic(script, (aiBase, posts) =>
      withRunningServer({ slug: SLUG, instancesDir, allowPrivateAiUrls: true }, (base) =>
        withPage(async (page) => {
          await seedProviders(page, aiBase)
          await openInterview(page, base)
          await page.click('[data-testid="interview-start"]')
          await page.waitForSelector('[data-testid="interview-round"]')
          assert.equal(await page.isDisabled('[data-testid="interview-finish"]'), false, 'always available')

          await page.click('[data-testid="interview-finish"]')
          await page.waitForFunction(() => document.querySelector('[data-testid="interview-round"]')?.getAttribute('data-final') === 'true')

          // The open cards were answered with the recommendations, and the AI was told to finish.
          const result = posts[1].body.messages.at(-1).content.find((b) => b.type === 'tool_result' && b.tool_use_id === 'a1').content
          assert.match(result, /\[k1\][^\n]*"k1 yes" \(your recommendation\)/)
          assert.match(result, /Finish with your recommendations/)
          // Gantry marked the figure the AI proposed, instead of sending the draft back.
          assert.match(await field(page, 'team-and-estimates.estimates').textContent(), /12 weeks \(target assumption\)/)
          assert.equal(await field(page, 'team-and-estimates.estimates').locator('[data-testid="interview-warning"]').count(), 0)

          // One last round, about only what the AI cannot propose; no stage-end card yet.
          assert.match(await roundText(page), /Last round · 1 question/)
          assert.deepEqual(await cardIds(page), ['owner'])
          assert.equal(await page.locator('[data-testid="interview-stage-end"]').count(), 0)
          await page.click('[data-testid="round-submit"]')
          await page.waitForSelector('[data-testid="interview-stage-end"]')
          assert.match(posts[2].body.messages.at(-1).content.find((b) => b.type === 'tool_result' && b.tool_use_id === 'a2').content, /last round/)
        })
      )
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('the kickoff shows how the AI will ask: native, text fallback or plain chat', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-287-'))
  try {
    createInstance('design', SLUG, { instancesDir, definitionVersion: 3 })
    await withRunningServer({ slug: SLUG, instancesDir, allowPrivateAiUrls: true }, (base) =>
      withPage(async (page) => {
        const passed = (questionCards) => ({ status: 'passed', testedAt: '2026-11-02T00:00:00Z', questionCards, readsImages: false, steps: [], message: 'ok' })
        const list = [
          { id: 'n', name: 'Native', type: 'anthropic', address: 'https://api.anthropic.com', key: 'k', model: 'm', isDefault: true, test: passed('native') },
          { id: 't', name: 'Text', type: 'custom', address: 'https://models.example/v1', key: 'k', model: 'm', isDefault: false, test: passed('text') },
          { id: 'c', name: 'Chat', type: 'custom', address: 'https://models.example/v1', key: 'k', model: 'm2', isDefault: false, test: passed('chat') },
        ]
        await page.addInitScript((value) => localStorage.setItem('gantry:ai-providers', value), JSON.stringify(list))
        await page.goto(`${base}/instance/${SLUG}?interview=1`)
        await page.waitForSelector('[data-testid="interview-card-mode"]')
        assert.equal(await page.getAttribute('[data-testid="interview-card-mode"]', 'data-mode'), 'native')
        assert.match(await page.textContent('[data-testid="interview-card-mode"]'), /native, then text, then plain chat/)
        assert.equal(await page.locator('[data-testid="interview-text-fallback"]').count(), 0)
        await page.selectOption('[data-testid="interview-provider"]', 't')
        await page.waitForFunction(() => document.querySelector('[data-testid="interview-card-mode"]')?.getAttribute('data-mode') === 'text')
        assert.match(await page.textContent('[data-testid="interview-text-fallback"]'), /text fallback/)
        await page.selectOption('[data-testid="interview-provider"]', 'c')
        await page.waitForFunction(() => document.querySelector('[data-testid="interview-card-mode"]')?.getAttribute('data-mode') === 'chat')
        assert.match(await page.textContent('[data-testid="interview-card-mode"]'), /plain chat/)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

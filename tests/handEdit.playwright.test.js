import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance, readModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'
import { parse as parseYAML } from 'yaml'

// #289 (parent #238, docs/adr/0064): the architect hand-edits an AI draft in the Interview page's live preview. A real server and
// relay, a real Chromium page, and a stand-in for Anthropic that plays a scripted interview (see tests/decisionsLog.playwright.test.js
// for the harness this follows). One turn is stalled half-way so the page can be seen while the AI is mid-draft.

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

// `script(body, n)` returns { text, tools, stall? } for the nth POST /v1/messages. A stalled reply sends everything up to the end of its
// first tool call's arguments, waits, then sends the rest.
const STALL_MS = 2500
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
      const reply = script(JSON.parse(raw), posts.length - 1)
      const body = anthropicReply(reply)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (reply.stall) {
        const cut = body.indexOf('event: content_block_stop')
        res.write(body.slice(0, cut))
        setTimeout(() => res.end(body.slice(cut)), STALL_MS)
      } else {
        res.end(body)
      }
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
const fill = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')
const CITE = '[Client brief, p. 1](source:client-brief)'
const draft = (id, field, value, extra = {}) => ({ id, input: { field, value, ...extra } })
const logCall = (id, input) => ({ id, name: 'log_decision', input })
const SOAP_DRAFTS = [
  draft('t1', 'background.problem', `Claims take too long to settle ${CITE}. ${fill(90)}.`, { inputs: [{ source: 'client-brief', range: 'pages 1-2' }] }),
  draft('t2', 'background.affected-domains', ['Claims', 'Member services', fill(18)]),
  draft('t3', 'solution-definition.high-level-requirements', `Members must lodge claims online ${CITE}. ${fill(110)}.`),
  draft('t4', 'solution-definition.high-level-solution-overview', `Configure the existing claims platform. ${fill(65)}.`),
  draft('t5', 'solution-definition.process-flow', `A member lodges, an assessor reviews, payment is made. ${fill(70)}.`),
  draft('t6', 'solution-definition.feature-breakdown', `Lodge a claim. Track its status. ${fill(70)}.`),
  draft('t7', 'team-and-estimates.teams-required', ['Claims', 'Integration', fill(60)]),
  draft('t8', 'team-and-estimates.estimates', `Delivery takes 12 weeks (target assumption). ${fill(70)}.`),
]
const MINE = 'My own words: claims take 12 days to settle, not the 14 the brief says.'
const field = (page, key) => page.locator(`[data-testid="interview-field"][data-field-key="${key}"]`)

async function addBrief(base) {
  await fetch(`${base}/api/instance/sources?slug=${SLUG}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'Client brief.md', dataBase64: Buffer.from('# Client brief\n\nClaims take too long.').toString('base64'), text: '# Client brief\n\nClaims take too long.' }),
  })
}

async function startAndDraft(page, base) {
  await page.goto(`${base}/instance/${SLUG}?interview=1`)
  await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
  await page.click('[data-testid="interview-start"]')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="interview-msg"][data-who="ai"]')].some((m) => /SOAP is drafted/.test(m.textContent)))
  await page.waitForSelector('[data-testid="interview-stage-end"]')
}

async function handEditProblem(page, text) {
  const problem = field(page, 'background.problem')
  await problem.locator('[data-testid="interview-field-value"]').click()
  await problem.locator('[data-testid="interview-field-input"]').fill(text)
  await problem.locator('[data-testid="interview-hand-done"]').click()
}

test('server workspace: a drafted Field is edited in place, the AI changes it only through a card, and the Save writes the hand edit', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-289-'))
  try {
    createInstance('design', SLUG, { instancesDir, definitionVersion: 3 })
    const script = (body, n) => {
      if (n === 0) return { text: 'I found one brief.', tools: SOAP_DRAFTS }
      if (n === 1) return { text: 'SOAP is drafted.' }
      // The architect chats; the AI redrafts the Field they edited, slowly.
      if (n === 2) return { stall: true, tools: [draft('t9', 'background.problem', `The AI would rather say this. ${fill(90)}.`)] }
      if (n === 3) return { text: 'I have put a card to you.' }
      return { text: 'Fine, yours stays.' }
    }
    await withFakeAnthropic(script, (aiBase, posts) =>
      withRunningServer({ slug: SLUG, instancesDir, allowPrivateAiUrls: true }, (base) =>
        withPage(async (page) => {
          await seedProviders(page, aiBase)
          await addBrief(base)
          const puts = []
          page.on('request', (req) => req.method() === 'PUT' && /\/api\/instance\/modules/.test(req.url()) && puts.push(req.url()))

          await startAndDraft(page, base)
          const problem = field(page, 'background.problem')
          assert.equal(await problem.locator('[data-testid="interview-ai-mark"]').count(), 1)
          assert.equal(await problem.locator('.cite').count(), 1, 'the AI draft cites the brief')

          // Click the Field: an editor opens showing the Markdown as stored. Save waits for it.
          await problem.locator('[data-testid="interview-field-value"]').click()
          assert.match(await problem.locator('[data-testid="interview-field-input"]').inputValue(), /source:client-brief/)
          assert.equal(await page.isDisabled('[data-testid="interview-save"]'), true, 'Save waits for an open edit')
          await problem.locator('[data-testid="interview-field-input"]').fill(MINE)
          await problem.locator('[data-testid="interview-hand-done"]').click()

          // It is the architect's now: marked so, no warning, no citation, no inputs.
          assert.match(await problem.locator('[data-testid="interview-hand-mark"]').textContent(), /Your edit · unsaved/)
          assert.equal(await problem.getAttribute('data-hand-edited'), 'true')
          assert.equal(await problem.locator('[data-testid="interview-ai-mark"]').count(), 0)
          assert.equal(await problem.locator('[data-testid="interview-warning"]').count(), 0)
          assert.equal(await problem.locator('.cite').count(), 0)
          assert.equal(await problem.locator('[data-testid="interview-field-inputs"]').count(), 0, 'the citation was removed, so the document is no longer an input')
          assert.match(await problem.textContent(), /My own words: claims take 12 days/)
          assert.equal(await page.isDisabled('[data-testid="interview-save"]'), false)

          // The editor shows saved content only, with a banner pointing to the Interview page.
          await page.click('[data-testid="interview-back"]')
          await page.waitForSelector('.module')
          const banner = page.locator('[data-testid="unsaved-ai-drafts"]').first()
          await banner.waitFor()
          assert.match(await banner.textContent(), /unsaved AI draft/)
          assert.match(await banner.textContent(), /Interview page/)
          assert.ok(!(await page.textContent('body')).includes('claims take 12 days'), 'the draft is not in the editor')
          await page.click('[data-testid="unsaved-ai-drafts-link"]')
          await page.waitForSelector('[data-testid="interview-page"]')
          assert.equal(await field(page, 'background.problem').getAttribute('data-hand-edited'), 'true', 'back in the same conversation')

          // The architect chats; the AI redrafts the Field. While it is being written the Field says so and can't be edited.
          await page.fill('[data-testid="interview-chat"]', 'Anything else you would change?')
          await page.click('[data-testid="interview-send"]')
          await field(page, 'background.problem').locator('[data-testid="interview-field-drafting"]').waitFor()
          assert.match(await field(page, 'background.problem').locator('[data-testid="interview-field-drafting"]').textContent(), /drafting…/)
          assert.equal(await field(page, 'background.problem').locator('[data-testid="interview-field-edit"]').count(), 0, 'no way to edit it mid-draft')
          await field(page, 'background.problem').locator('[data-testid="interview-field-drafting"]').waitFor({ state: 'detached' })

          // The AI's version meets a card, with the architect's text beside it. The preview still has theirs.
          const card = page.locator('[data-testid="interview-card"][data-card-type="change"]')
          await card.waitFor()
          assert.match(await card.textContent(), /Your edit/)
          assert.match(await card.locator('[data-testid="change-saved"]').textContent(), /My own words/)
          assert.match(await card.locator('[data-testid="change-proposed"]').textContent(), /The AI would rather say this/)
          assert.match(await field(page, 'background.problem').textContent(), /My own words/)
          await page.click('[data-testid="round-submit"]') // Keep is the recommendation
          await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="interview-msg"][data-who="ai"]')].some((m) => /yours stays/.test(m.textContent)))
          assert.match(await field(page, 'background.problem').textContent(), /My own words/)
          assert.ok(posts.at(-1).raw.includes('stays as the architect wrote it'), 'the AI was told to leave it')

          // Save: the content has the architect's text; the log has the hand edit, the keep, and a Field record rebuilt from the text.
          assert.equal(puts.length, 0)
          await page.click('[data-testid="interview-save"]')
          await page.waitForSelector('[data-testid="interview-saved"]')
          assert.equal(puts.length, 1)
          const design = loadDefinition('design', { definitionsDir: 'definitions', version: 3 })
          const background = readModule(design, SLUG, 'background', { instancesDir: join(instancesDir, 'default') })
          assert.equal(background.fields.problem, MINE)
          const log = parseYAML(readFileSync(join(instancesDir, 'default', SLUG, 'interview', 'shape.yaml'), 'utf8'))
          const edit = log.entries.find((e) => e.kind === 'hand-edit')
          assert.equal(edit.words, MINE, 'the typed text, as the architect\'s own words')
          assert.deepEqual(edit.fields, ['background.problem'])
          const kept = log.entries.find((e) => e.kind === 'saved-content')
          assert.deepEqual({ choice: kept.choice, handEdit: kept.handEdit }, { choice: 'keep', handEdit: true })
          assert.deepEqual(log.fields['background.problem'].inputs, [])
          assert.deepEqual(log.fields['background.problem'].entries, [edit.id])
          // A Field nobody edited keeps its inputs.
          assert.ok(log.fields['solution-definition.high-level-requirements'].inputs.some((i) => i.source === 'client-brief'))

          // The editor's read-only panel shows the hand edit.
          await page.click('[data-testid="interview-back"]')
          await page.waitForSelector('[data-testid="decisions-log-panel"]')
          assert.match(await page.textContent('[data-testid="decisions-latest"]'), /edited .* by hand/)
          assert.equal(await page.locator('[data-testid="unsaved-ai-drafts"]').count(), 0, 'saved, so no banner')
        })
      )
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('server workspace: asking for the change in free chat hands a hand-edited Field back, with no card', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-289-'))
  try {
    createInstance('design', SLUG, { instancesDir, definitionVersion: 3 })
    const shorter = `Claims are slow. ${fill(90)}.`
    const script = (body, n) => {
      if (n === 0) return { text: 'I found one brief.', tools: SOAP_DRAFTS }
      if (n === 1) return { text: 'SOAP is drafted.' }
      if (n === 2) return { tools: [logCall('l1', { kind: 'fact', quote: 'Please redo the problem statement', fields: ['background.problem'] }), draft('t9', 'background.problem', shorter)] }
      return { text: 'Redone.' }
    }
    await withFakeAnthropic(script, (aiBase, posts) =>
      withRunningServer({ slug: SLUG, instancesDir, allowPrivateAiUrls: true }, (base) =>
        withPage(async (page) => {
          await seedProviders(page, aiBase)
          await addBrief(base)
          await startAndDraft(page, base)
          await handEditProblem(page, MINE)
          assert.equal(await field(page, 'background.problem').getAttribute('data-hand-edited'), 'true')

          await page.fill('[data-testid="interview-chat"]', 'Please redo the problem statement, it is too long.')
          await page.click('[data-testid="interview-send"]')
          await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="interview-msg"][data-who="ai"]')].some((m) => /Redone/.test(m.textContent)))
          const problem = field(page, 'background.problem')
          assert.match(await problem.textContent(), /Claims are slow/)
          assert.equal(await problem.getAttribute('data-hand-edited'), 'false')
          assert.equal(await problem.locator('[data-testid="interview-ai-mark"]').count(), 1, 'the AI\'s text is in, marked as an AI draft')
          assert.equal(await page.locator('[data-testid="interview-round"]').count(), 0, 'no card: the architect asked')
          assert.ok(posts[2].raw.includes('My own words: claims take 12 days'), 'the AI had been told what the architect wrote')

          // Edit it again: a new hand edit that replaces the first.
          await handEditProblem(page, 'Second thoughts.')
          assert.match(await problem.textContent(), /Second thoughts\./)
          await page.click('[data-testid="interview-back"]')
          await page.click('[data-testid="unsaved-ai-drafts-link"]')
          await page.waitForSelector('[data-testid="interview-page"]')
          await page.click('[data-testid="interview-save"]')
          await page.waitForSelector('[data-testid="interview-saved"]')
          const design = loadDefinition('design', { definitionsDir: 'definitions', version: 3 })
          assert.equal(readModule(design, SLUG, 'background', { instancesDir: join(instancesDir, 'default') }).fields.problem, 'Second thoughts.', 'the Save still wrote the drafts after a visit to the editor')
          const log = parseYAML(readFileSync(join(instancesDir, 'default', SLUG, 'interview', 'shape.yaml'), 'utf8'))
          const edits = log.entries.filter((e) => e.kind === 'hand-edit')
          assert.deepEqual(edits.map((e) => e.words), [MINE, 'Second thoughts.'])
          assert.deepEqual(edits[1].replaces, [edits[0].id])
          const fact = log.entries.find((e) => e.kind === 'fact')
          assert.equal(fact.words, 'Please redo the problem statement, it is too long.')
        })
      )
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

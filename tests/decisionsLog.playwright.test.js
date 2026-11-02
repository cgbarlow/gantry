import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'
import { parse as parseYAML } from 'yaml'

// #288 (parent #238, docs/adr/0064): the decisions log on the Interview page and in the editor, end to end. A real server and relay, a real Chromium
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
const logCall = (id, input) => ({ id, name: 'log_decision', input })
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

async function addBrief(base) {
  await fetch(`${base}/api/instance/sources?slug=${SLUG}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: 'Client brief.md', dataBase64: Buffer.from('# Client brief\n\nClaims take too long.').toString('base64'), text: '# Client brief\n\nClaims take too long.' }),
  })
}

// n0: the AI summarises, drafts the SOAP (naming what it drew on), logs an open question and asks one card.
// n1: after the round is answered. n2: after the architect's chat, it logs the fact they typed. n3: it says it has noted it.
const loggedScript = (body, n) => {
  if (n === 0) {
    return {
      text: 'I found one brief.',
      tools: [
        { ...SOAP_DRAFTS[0], input: { ...SOAP_DRAFTS[0].input, inputs: [{ source: 'client-brief', range: 'pages 1-2' }] } },
        ...SOAP_DRAFTS.slice(1),
        draft('t8', 'team-and-estimates.estimates', ESTIMATE_MARKED),
        logCall('o1', { kind: 'open-question', question: 'Who is the executive sponsor?', why: 'The brief does not name one.', fields: ['background.opportunity'] }),
        ask('a1', [qcard('scope', { field: 'background.problem', question: 'Is claims handling in scope?', source: { document: 'client-brief', location: 'p. 1' } })]),
      ],
    }
  }
  if (n === 1) return { text: 'Thanks. SOAP is drafted.' }
  if (n === 2) return { tools: [logCall('l1', { kind: 'fact', quote: 'sponsor is Pat', fields: ['team-and-estimates.teams-required'] })] }
  return { text: 'Noted: the sponsor is Pat.' }
}

async function runInterview(page, base) {
  await page.goto(`${base}/instance/${SLUG}?interview=1`)
  await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
  await page.click('[data-testid="interview-start"]')
  await page.waitForSelector('[data-testid="interview-round"]')
  await page.click('[data-testid="round-submit"]')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="interview-msg"][data-who="ai"]')].some((m) => /SOAP is drafted/.test(m.textContent)))
  await page.fill('[data-testid="interview-chat"]', 'Thanks! Please note the sponsor is Pat, from Finance.')
  await page.click('[data-testid="interview-send"]')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="interview-msg"][data-who="ai"]')].some((m) => /Noted: the sponsor/.test(m.textContent)))
  await page.waitForSelector('[data-testid="interview-stage-end"]')
}

test('server workspace: a stage Save writes the decisions log and the content in one request, and the editor shows the log read-only', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-288-'))
  try {
    createInstance('design', SLUG, { instancesDir, definitionVersion: 3 })
    await withFakeAnthropic(loggedScript, (aiBase, posts) =>
      withRunningServer({ slug: SLUG, instancesDir, allowPrivateAiUrls: true }, (base) =>
        withPage(async (page) => {
          await seedProviders(page, aiBase)
          await addBrief(base)
          const puts = []
          page.on('request', (req) => req.method() === 'PUT' && /\/api\/instance\/(modules|decisions)/.test(req.url()) && puts.push({ url: req.url(), body: req.postData() }))

          await runInterview(page, base)

          // The rail counts the decisions so far: the answered card and the fact, with the open question called out.
          assert.equal((await page.textContent('[data-testid="interview-decisions-count"]')).trim(), '3')
          assert.match(await page.textContent('[data-testid="interview-decisions-open"]'), /1 open question/)
          assert.match(await page.textContent('[data-testid="interview-decisions-unsaved"]'), /not saved yet/)
          assert.equal(puts.length, 0, 'nothing is written before the Save')

          await page.click('[data-testid="interview-save"]')
          await page.waitForSelector('[data-testid="interview-saved"]')

          // One request carried the Modules and the log.
          assert.equal(puts.length, 1)
          assert.match(puts[0].url, /\/api\/instance\/modules/)
          const sent = JSON.parse(puts[0].body)
          assert.ok(sent.modules.background, 'the content')
          assert.ok(sent.decisions.entries.length >= 4, 'and the log')

          const file = join(instancesDir, 'default', SLUG, 'interview', 'shape.yaml')
          const text = readFileSync(file, 'utf8')
          const log = parseYAML(text)
          assert.deepEqual(log.entries.map((e) => e.kind).sort(), ['answer', 'artefact', 'fact', 'open-question'])
          const fact = log.entries.find((e) => e.kind === 'fact')
          assert.equal(fact.words, 'Thanks! Please note the sponsor is Pat, from Finance.', 'the architect\'s own message, word for word')
          assert.deepEqual(fact.fields, ['team-and-estimates.teams-required'])
          const card = log.entries.find((e) => e.kind === 'answer')
          assert.equal(card.question, 'Is claims handling in scope?')
          assert.deepEqual(card.answer, ['scope yes'])
          assert.deepEqual(card.sources, ['client-brief, p. 1'])
          // The Field record: what it was drafted from, with fingerprints, including the citation Gantry saw.
          const inputs = log.fields['background.problem'].inputs
          assert.ok(inputs.some((i) => i.source === 'client-brief' && i.range === 'pages 1-2' && /^[0-9a-f]{14}$/.test(i.fingerprint)))
          assert.ok(inputs.some((i) => i.source === 'client-brief' && i.range === null && /^[0-9a-f]{14}$/.test(i.fingerprint)))
          assert.deepEqual(log.fields['background.problem'].entries, [card.id])
          // The status block, and nothing it must not hold.
          assert.equal(log.status.length, 1)
          assert.equal(log.status[0].target, 'shape')
          assert.equal(log.status[0].artefact, 'soap')
          assert.deepEqual(log.status[0].models.map((m) => [m.type, m.model]), [['anthropic', 'claude-small']])
          assert.ok(log.status[0].models[0].inputTokens > 0)
          for (const secret of ['key-one', aiBase, 'First AI', 'ZZZ']) assert.ok(!text.includes(secret), `${secret} is not in the file`)
          assert.ok(!text.includes('I found one brief'), 'nothing the AI said is kept')
          assert.ok(!text.includes('Thanks. SOAP is drafted'), 'nothing the AI said is kept')

          // Back in the editor: the read-only Decisions log panel.
          await page.click('[data-testid="interview-back"]')
          await page.waitForSelector('[data-testid="decisions-log-panel"]')
          assert.equal((await page.textContent('[data-testid="decisions-log-count"]')).trim(), '3')
          assert.match(await page.textContent('[data-testid="decisions-latest"]'), /Is claims handling in scope\?/)
          assert.match(await page.textContent('[data-testid="decisions-latest"]'), /sponsor is Pat/)
          const open = page.locator('[data-testid="decisions-open"]')
          assert.match(await open.textContent(), /Who is the executive sponsor\?/)
          assert.match(await page.getAttribute('[data-testid="decisions-resume"]', 'href'), /interview=1/)
          assert.equal(await page.locator('[data-testid="decisions-history"]').count(), 0, 'history only on request')
          await page.click('[data-testid="decisions-history-toggle"]')
          assert.equal(await page.locator('[data-testid="decisions-history"] [data-kind="artefact"]').count(), 1)
          assert.equal(await page.locator('[data-testid="decisions-log-panel"] input, [data-testid="decisions-log-panel"] textarea').count(), 0, 'read-only')

          // "Resume to answer" opens the Interview again, and the rail shows the committed count.
          await page.click('[data-testid="decisions-resume"]')
          await page.waitForSelector('[data-testid="interview-page"]')
          await page.waitForFunction(() => document.querySelector('[data-testid="interview-decisions-count"]')?.textContent.trim() === '3')
          assert.equal(await page.locator('[data-testid="interview-decisions-unsaved"]').count(), 0)
        })
      )
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('server workspace: the committed log is what the AI is told is settled, and Start this stage over appends a restart marker', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-288-'))
  try {
    createInstance('design', SLUG, { instancesDir, definitionVersion: 3 })
    await withFakeAnthropic(
      (body, n) => (n === 0 ? { text: 'Hello.' } : { text: 'Again.' }),
      (aiBase, posts) =>
        withRunningServer({ slug: SLUG, instancesDir, allowPrivateAiUrls: true }, (base) =>
          withPage(async (page) => {
            await seedProviders(page, aiBase)
            // A log from an earlier session.
            const earlier = { id: 'old-1', kind: 'answer', at: '2026-11-01T10:00:00.000Z', session: 's-old', question: 'Who pays for it?', answer: ['The COO'], fields: ['background.problem'] }
            const saved = await fetch(`${base}/api/instance/decisions?slug=${SLUG}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decisions: { entries: [earlier] } }) })
            assert.equal(saved.status, 200)

            await page.goto(`${base}/instance/${SLUG}?interview=1`)
            await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
            await page.waitForFunction(() => document.querySelector('[data-testid="interview-decisions-count"]')?.textContent.trim() === '1')
            await page.click('[data-testid="interview-start"]')
            await page.waitForSelector('[data-testid="interview-msg"][data-who="ai"]')
            assert.match(posts[0].body.system, /Who pays for it\?/, 'the AI is told what is settled')

            await page.click('[data-testid="interview-restart"]')
            await page.click('[data-testid="interview-restart-yes"]')
            await page.waitForSelector('[data-testid="interview-kickoff"]')
            assert.equal((await page.textContent('[data-testid="interview-decisions-count"]')).trim(), '0', 'nothing before the marker holds any more')
            await page.click('[data-testid="interview-start"]')
            await page.waitForSelector('[data-testid="interview-msg"][data-who="ai"]')
            assert.ok(!posts.at(-1).body.system.includes('Who pays for it?') || /fresh start/.test(posts.at(-1).body.system), 'the AI ignores earlier answers after a restart')
            assert.match(posts.at(-1).body.system, /Nothing is logged for this Stage yet/)
          })
        )
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('local workspace: the decisions log is written through the folder in the same Save as the content', async () => {
  await withFakeAnthropic(
    (body, n) => (n === 0 ? { text: 'One brief.', tools: SOAP_DRAFTS.concat(draft('t8', 'team-and-estimates.estimates', ESTIMATE_MARKED)) } : { text: 'Drafted.' }),
    (aiBase) =>
      withRunningServer({ allowPrivateAiUrls: true }, (base) =>
        withPage(async (page) => {
          await seedProviders(page, aiBase)
          await page.goto(`${base}/settings`)
          const workspaceId = await page.evaluate(async () => {
            const { rememberWorkspace } = await import('/lib/localWorkspace.js')
            const root = await navigator.storage.getDirectory()
            const dir = await root.getDirectoryHandle('local-ws-' + Date.now(), { create: true })
            const sub = await (await dir.getDirectoryHandle('gantry-workspace', { create: true })).getDirectoryHandle('local-int', { create: true })
            const w = await (await sub.getFileHandle('instance.yaml', { create: true })).createWritable()
            await w.write('definition: design\nslug: local-int\nstage: shape\nassignee: a.architect\ndefinitionVersion: 3\n')
            await w.close()
            return rememberWorkspace({ handle: dir, name: 'Local Interview Workspace' })
          })
          await page.goto(`${base}/instance/local-int?local=${encodeURIComponent(workspaceId)}`)
          await page.waitForSelector('.module')
          await page.click('[data-testid="open-ai-interview"]')
          await page.waitForSelector('[data-testid="interview-kickoff"]')
          await page.setInputFiles('[data-testid="source-documents-compact"] [data-testid="source-documents-input"]', {
            name: 'Client brief.md',
            mimeType: 'text/markdown',
            buffer: Buffer.from('# Client brief\n\nClaims take too long to settle.'),
          })
          await page.waitForSelector('[data-testid="source-documents-list"] [data-source-id="client-brief"]')
          await page.waitForFunction(() => /1 Source document/.test(document.querySelector('[data-testid="interview-source-count"]')?.textContent ?? ''))
          await page.click('[data-testid="interview-start"]')
          await page.waitForSelector('[data-testid="interview-stage-end"]')
          await page.click('[data-testid="interview-save"]')
          await page.waitForSelector('[data-testid="interview-saved"]')

          const files = await page.evaluate(async () => {
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
            return {
              module: await readTextFile(handle, 'gantry-workspace/local-int/modules/background.md'),
              log: await readTextFile(handle, 'gantry-workspace/local-int/interview/shape.yaml'),
            }
          })
          assert.match(files.module, /Claims take too long to settle/)
          const log = parseYAML(files.log)
          assert.equal(log.stage, 'shape')
          assert.deepEqual(log.entries.map((e) => e.kind), ['artefact'])
          assert.ok(log.fields['background.problem'].inputs.some((i) => i.source === 'client-brief'))
          assert.equal(log.status[0].who, 'a.architect')
          assert.ok(!files.log.includes('key-one') && !files.log.includes(aiBase))

          // The editor's panel reads it back from the folder.
          await page.click('[data-testid="interview-back"]')
          await page.waitForSelector('[data-testid="decisions-log-panel"]')
          assert.match(await page.textContent('[data-testid="decisions-log-panel"]'), /Nothing answered yet/)
        })
      )
  )
})

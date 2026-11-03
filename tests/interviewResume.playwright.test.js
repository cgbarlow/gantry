import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'
import { modulePayload } from '../web/lib/stageSave.js'

// #290 (parent #238, docs/adr/0064 and 0068): Pause and resume on the Interview page, end to end. A real server and relay, a real
// Chromium and a stand-in for Anthropic that plays a short scripted interview and records everything it is sent. "Another browser" is
// a second browser context (its own local storage); "the same browser" is a second page of one context.

const SLUG = 'my-initiative'
const CITE = '[Client brief, p. 1](source:client-brief)'
const fill = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ')
const PROBLEM = `Claims take too long to settle ${CITE}. ${fill(90)}.`

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
      const body = JSON.parse(raw)
      posts.push({ raw, body })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(anthropicReply(script(body, posts.length - 1)))
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
const firstText = (body) => JSON.stringify(body.messages[0])

// The interview: draft the Problem and ask two cards; after the answers, say thanks. A resumed run (its first message says so) welcomes back.
function interviewScript(body) {
  if (firstText(body).includes('Resume the interview')) return { text: 'Welcome back. Picking up from the log.' }
  if (JSON.stringify(body.system).includes('You merge two versions')) {
    return { text: JSON.stringify({ merges: [{ id: 'clash:background:field:problem', text: 'Merged: claims are slow and members wait too long.' }] }) }
  }
  if (body.messages.length === 1) {
    return { text: 'I read the brief.', tools: [{ id: 't1', input: { field: 'background.problem', value: PROBLEM } }, ask('a1', [qcard('c1', { field: 'background.problem' }), qcard('c2', { header: 'Hosting' })])] }
  }
  return { text: 'Thanks, noted.' }
}

// Every page of a context starts with the same AI Provider list.
function seedProviders(target, aiBase) {
  const passed = { status: 'passed', testedAt: '2026-11-02T00:00:00Z', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }
  const list = [{ id: 'one', name: 'First AI', type: 'anthropic', address: aiBase, key: 'key-one', model: 'claude-small', isDefault: true, test: passed }]
  return target.addInitScript((value) => localStorage.setItem('gantry:ai-providers', value), JSON.stringify(list))
}

async function withBrowser(fn) {
  const browser = await launchBrowser()
  try {
    const pageErrors = []
    const open = async (aiBase, context = null) => {
      const ctx = context ?? (await browser.newContext({ viewport: { width: 1500, height: 1000 } }))
      if (!context) await seedProviders(ctx, aiBase)
      const page = await ctx.newPage()
      page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
      page.on('pageerror', (err) => pageErrors.push(err.message))
      return { ctx, page }
    }
    await fn(open, browser)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

async function withInstance(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-290-'))
  try {
    createInstance('design', SLUG, { instancesDir, definitionVersion: 3 })
    await withRunningServer({ slug: SLUG, instancesDir, allowPrivateAiUrls: true }, async (base) => {
      await fetch(`${base}/api/instance/sources?slug=${SLUG}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'Client brief.md', dataBase64: Buffer.from('# Client brief\n\nClaims take too long.').toString('base64'), text: '# Client brief\n\nClaims take too long.' }),
      })
      const stageId = (await (await fetch(`${base}/api/instance?slug=${SLUG}`)).json()).stage.id
      const logFile = join(instancesDir, 'default', SLUG, 'interview', `${stageId}.yaml`)
      const readLog = () => parseYAML(readFileSync(logFile, 'utf8'))
      await fn({ base, stageId, instancesDir, readLog })
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

const openInterview = async (page, base) => {
  await page.goto(`${base}/instance/${SLUG}?interview=1`)
  await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
}
const problemField = (page) => page.locator('[data-testid="interview-field"][data-field-key="background.problem"]')

// Starts, lets the AI draft the Problem and ask two cards, answers them, and waits for the AI to finish its next turn.
async function runFirstRound(page) {
  await page.click('[data-testid="interview-start"]')
  await page.waitForSelector('[data-testid="interview-round"]')
  await page.click('[data-testid="round-submit"]')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="interview-msg"][data-who="ai"]')].some((m) => /Thanks, noted/.test(m.textContent)))
  await page.waitForSelector('[data-testid="interview-working"]', { state: 'detached' })
}

// A colleague's save of a Field, through the same API the editor uses.
async function colleagueSaves(base, moduleId, fieldId, value) {
  const data = await (await fetch(`${base}/api/instance?slug=${SLUG}`)).json()
  const mod = data.modules.find((m) => m.id === moduleId)
  const payload = modulePayload({ ...mod, fields: mod.fields.map((f) => (f.id === fieldId ? { ...f, value } : f)) })
  const res = await fetch(`${base}/api/instance/modules?stage=${data.stage.id}&slug=${SLUG}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ modules: { [moduleId]: payload } }),
  })
  assert.equal(res.status, 200, await res.text())
}

test('Pause saves the log and drafts; another browser recaps from the log and carries on without the old conversation', async () => {
  await withInstance(async ({ base, stageId, readLog }) => {
    await withFakeAnthropic(interviewScript, (aiBase, posts) =>
      withBrowser(async (open) => {
        const a = await open(aiBase)
        await openInterview(a.page, base)
        assert.equal(await a.page.locator('[data-testid="interview-resume-recap"]').count(), 0, 'a first run is not a resume')
        await runFirstRound(a.page)
        assert.equal(readLogOrNull(readLog), null, 'nothing is committed until a Save or a Pause')

        await a.page.click('[data-testid="interview-pause"]')
        await a.page.waitForSelector('[data-testid="interview-paused"]')
        const log = readLog()
        assert.equal(log.status.length, 1)
        assert.equal(log.status[0].state, 'paused')
        assert.ok(log.status[0].lastAiSave)
        assert.equal(log.entries.filter((e) => e.kind === 'answer').length, 2)
        const saved = await (await fetch(`${base}/api/instance?slug=${SLUG}&stage=${stageId}`)).json()
        const background = saved.modules.find((m) => m.id === 'background')
        assert.match(background.fields.find((f) => f.id === 'problem').value, /Claims take too long to settle/)
        assert.equal(background.status, 'draft', 'the drafts stay draft')

        // "Resume now" opens the page afresh from the saved log and content, in this same browser.
        await a.page.click('[data-testid="interview-resume"]')
        await a.page.waitForSelector('[data-testid="interview-resume-recap"]')
        assert.match(await a.page.textContent('[data-testid="interview-start"]'), /Resume interview/)
        assert.equal(await problemField(a.page).getAttribute('data-state'), 'saved', 'the paused drafts are saved content now')

        // Another browser: no working copy, no old conversation. It sees the recap before it starts.
        const before = posts.length
        const b = await open(aiBase)
        await openInterview(b.page, base)
        assert.match(await b.page.textContent('[data-testid="interview-resume-recap"]'), /Resuming .*: 2 decisions, 0 open questions, last asked about Hosting/)
        assert.match(await b.page.textContent('[data-testid="interview-start"]'), /Resume interview/)
        await b.page.click('[data-testid="interview-start"]')
        await b.page.waitForFunction(() => [...document.querySelectorAll('[data-testid="interview-msg"][data-who="ai"]')].some((m) => /Welcome back/.test(m.textContent)))
        const resumed = posts[before]
        assert.equal(resumed.body.messages.length, 1, 'the AI is given the log and the saved content, not the conversation')
        assert.ok(!resumed.raw.includes('I read the brief.') && !resumed.raw.includes('Thanks, noted.'), 'none of the earlier conversation is sent')
        assert.match(resumed.raw, /Resume the interview/)
        assert.match(resumed.raw, /Resuming .*: 2 decisions/)
        assert.match(resumed.raw, /Claims take too long to settle/, 'the saved content is in its brief')
        assert.match(resumed.raw, /Question c1\?/, 'and so is the decisions log')

        // Pausing again keeps one status line: the resumed run is the same session carrying on.
        await b.page.click('[data-testid="interview-pause"]')
        await b.page.waitForSelector('[data-testid="interview-paused"]')
        const again = readLog()
        assert.equal(again.status.length, 1)
        assert.equal(again.status[0].session, log.status[0].session)
      })
    )
  })
})

function readLogOrNull(readLog) {
  try {
    return readLog()
  } catch {
    return null
  }
}

test('closing the tab without pausing and reopening in the same browser resumes exactly', async () => {
  await withInstance(async ({ base }) => {
    await withFakeAnthropic(interviewScript, (aiBase, posts) =>
      withBrowser(async (open) => {
        const first = await open(aiBase)
        await openInterview(first.page, base)
        await runFirstRound(first.page)
        const sent = posts.length
        await first.page.close()

        const { page } = await open(aiBase, first.ctx)
        await page.goto(`${base}/instance/${SLUG}?interview=1`)
        await page.waitForSelector('[data-testid="interview-copy-restored"]')
        assert.equal(await page.locator('[data-testid="interview-kickoff"]').count(), 0, 'no kickoff: the session is back')
        assert.match(await problemField(page).textContent(), /AI draft · unsaved/)
        assert.match(await page.textContent('[data-testid="interview-thread"]'), /I read the brief\./)
        assert.match(await page.textContent('[data-testid="interview-thread"]'), /Thanks, noted\./)
        assert.match(await page.textContent('[data-testid="interview-decisions-summary"]'), /not saved yet/, 'the answers are still waiting for a Save')
        assert.equal(posts.length, sent, 'nothing was sent to the AI to get back')

        // It carries on with the whole history, not a recap.
        await page.fill('[data-testid="interview-chat"]', 'Also mention hosting.')
        await page.click('[data-testid="interview-send"]')
        await page.waitForFunction(() => document.querySelectorAll('[data-testid="interview-msg"][data-who="ai"]').length >= 3)
        assert.ok(posts.at(-1).body.messages.length > 3, 'the AI was given the conversation so far')
      })
    )
  })
})

test('a browser copy older than the committed log is set aside with a notice', async () => {
  await withInstance(async ({ base, stageId }) => {
    await withFakeAnthropic(interviewScript, (aiBase) =>
      withBrowser(async (open) => {
        const first = await open(aiBase)
        await openInterview(first.page, base)
        await runFirstRound(first.page)
        await first.page.close()

        // Meanwhile the same architect saved from another browser: the committed log has an entry this copy does not know.
        const res = await fetch(`${base}/api/instance/decisions?slug=${SLUG}&stage=${stageId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decisions: { entries: [{ id: 'other-1', kind: 'fact', at: '2026-11-02T09:00:00Z', session: 'other', words: 'Hosting is on Azure.', fields: ['background.problem'] }] } }),
        })
        assert.equal(res.status, 200, await res.text())

        const { page } = await open(aiBase, first.ctx)
        await page.goto(`${base}/instance/${SLUG}?interview=1`)
        await page.waitForSelector('[data-testid="interview-copy-aside"]')
        assert.match(await page.textContent('[data-testid="interview-copy-aside"]'), /set aside/)
        assert.equal(await page.locator('[data-testid="interview-copy-restored"]').count(), 0)
        assert.equal(await problemField(page).getAttribute('data-state'), 'empty', 'the unsaved drafts were not brought back')
        assert.match(await page.textContent('[data-testid="interview-resume-recap"]'), /Resuming .*: 1 decision/, 'the committed log wins')
        const kept = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('gantry:interview-copy')))
        assert.deepEqual(kept.map((k) => k.replace(/\|.*/, '')), ['gantry:interview-copy-aside:' + SLUG], 'the copy is kept aside, not deleted')
        await page.click('[data-testid="interview-copy-aside-dismiss"]')
        assert.equal(await page.locator('[data-testid="interview-copy-aside"]').count(), 0)
      })
    )
  })
})

test('a Field both sides changed becomes a round of cards with the AI’s merged wording, and the choice is logged', async () => {
  await withInstance(async ({ base, readLog }) => {
    await withFakeAnthropic(interviewScript, (aiBase) =>
      withBrowser(async (open) => {
        const { page } = await open(aiBase)
        await openInterview(page, base)
        await runFirstRound(page)

        // A colleague saves the same Field while the session holds an unsaved draft of it.
        await colleagueSaves(base, 'background', 'problem', 'Their wording of the problem.')

        await page.click('[data-testid="interview-pause"]')
        await page.waitForSelector('[data-testid="interview-clash"]')
        const card = page.locator('[data-testid="clash-card"][data-field="background.problem"]')
        assert.match(await card.locator('[data-testid="clash-theirs"]').textContent(), /Their wording of the problem\./)
        assert.match(await card.locator('[data-testid="clash-mine"]').textContent(), /Claims take too long to settle/)
        assert.equal(await page.isDisabled('[data-testid="clash-submit"]'), true, 'nothing is pre-selected')
        await card.locator('[data-testid="clash-merged"]').waitFor()
        assert.match(await card.locator('[data-testid="clash-merged"]').textContent(), /Merged: claims are slow/)
        assert.equal(await card.locator('[data-testid="clash-option"]').count(), 3)

        // Nothing was written yet.
        assert.equal(readLogOrNull(readLog), null)
        await card.locator('[data-testid="clash-option"][data-option="The AI\'s merged wording"]').click()
        await page.click('[data-testid="clash-submit"]')
        await page.waitForSelector('[data-testid="interview-paused"]')

        const saved = await (await fetch(`${base}/api/instance?slug=${SLUG}`)).json()
        assert.equal(saved.modules.find((m) => m.id === 'background').fields.find((f) => f.id === 'problem').value, 'Merged: claims are slow and members wait too long.')
        const log = readLog()
        const choice = log.entries.find((e) => e.kind === 'save-clash')
        assert.equal(choice.choice, 'merged')
        assert.equal(choice.field, 'background.problem')
        assert.equal(log.entries.filter((e) => e.kind === 'answer').length, 2, 'the answers were saved in the same Save')
      })
    )
  })
})

test('cancelling the clash cards writes nothing and keeps keep-theirs available', async () => {
  await withInstance(async ({ base, readLog }) => {
    await withFakeAnthropic(interviewScript, (aiBase) =>
      withBrowser(async (open) => {
        const { page } = await open(aiBase)
        await openInterview(page, base)
        await runFirstRound(page)
        await colleagueSaves(base, 'background', 'problem', 'Their wording of the problem.')
        await page.click('[data-testid="interview-pause"]')
        await page.waitForSelector('[data-testid="interview-clash"]')
        await page.click('[data-testid="clash-cancel"]')
        await page.waitForSelector('[data-testid="interview-pause-error"]')
        assert.equal(readLogOrNull(readLog), null, 'a cancelled Save writes nothing')
        assert.equal(await problemField(page).getAttribute('data-state'), 'draft', 'the draft is still there')

        await page.click('[data-testid="interview-pause"]')
        await page.waitForSelector('[data-testid="interview-clash"]')
        await page.locator('[data-testid="clash-option"][data-option="Keep theirs"]').click()
        await page.click('[data-testid="clash-submit"]')
        await page.waitForSelector('[data-testid="interview-paused"]')
        const saved = await (await fetch(`${base}/api/instance?slug=${SLUG}`)).json()
        assert.equal(saved.modules.find((m) => m.id === 'background').fields.find((f) => f.id === 'problem').value, 'Their wording of the problem.')
        const log = readLog()
        assert.deepEqual(log.entries.filter((e) => e.kind === 'save-clash').map((e) => e.choice), ['theirs'], 'only the choice that was carried out is logged')
      })
    )
  })
})

test('a second session on the same stage gets the warning card, and both logs merge in time order', async () => {
  // The log already has decisions, so this run is a resume; the AI asks its next round straight away.
  const askAgain = (body, n) =>
    firstText(body).includes('Resume the interview')
      ? body.messages.length === 1
        ? { text: 'Resuming.', tools: [{ id: 't1', input: { field: 'background.problem', value: PROBLEM } }, ask('a1', [qcard('c1', { field: 'background.problem' }), qcard('c2', { header: 'Hosting' })])] }
        : { text: 'Thanks, noted.' }
      : interviewScript(body, n)
  await withInstance(async ({ base, stageId, readLog }) => {
    await withFakeAnthropic(askAgain, (aiBase) =>
      withBrowser(async (open) => {
        // Another session answered Question c1 earlier and has not finished.
        const res = await fetch(`${base}/api/instance/decisions?slug=${SLUG}&stage=${stageId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decisions: {
              status: { session: 's-other', who: 'Pat', state: 'in-progress', lastAiSave: '2026-11-02T08:00:00Z' },
              entries: [{ id: 's-other-1', kind: 'answer', at: '2026-11-02T08:00:00Z', session: 's-other', question: 'Question c1?', answer: ['c1 no'], fields: ['background.problem'] }],
            },
          }),
        })
        assert.equal(res.status, 200, await res.text())

        const { page } = await open(aiBase)
        await openInterview(page, base)
        await page.click('[data-testid="interview-start"]')
        await page.waitForSelector('[data-testid="interview-session-warning"]')
        assert.match(await page.textContent('[data-testid="interview-other-session"]'), /last saved/)
        assert.equal(await page.locator('[data-testid="interview-round"]').count(), 0, 'nothing started yet')

        await page.click('[data-testid="interview-warning-cancel"]')
        assert.equal(await page.locator('[data-testid="interview-session-warning"]').count(), 0)
        await page.click('[data-testid="interview-start"]')
        await page.click('[data-testid="interview-warning-carry-on"]')
        await page.waitForSelector('[data-testid="interview-round"]')
        await page.click('[data-testid="round-submit"]')
        await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="interview-msg"][data-who="ai"]')].some((m) => /Thanks, noted/.test(m.textContent)))
        await page.waitForSelector('[data-testid="interview-working"]', { state: 'detached' })
        await page.click('[data-testid="interview-pause"]')
        await page.waitForSelector('[data-testid="interview-paused"]')

        const log = readLog()
        assert.equal(log.status.length, 2, 'one status line per session')
        const answers = log.entries.filter((e) => e.kind === 'answer')
        assert.equal(answers[0].id, 's-other-1', 'the other session’s entry stays first in time order')
        const times = log.entries.map((e) => e.at)
        assert.deepEqual(times, [...times].sort(), 'both sets of entries are in time order')
        const ours = answers.find((e) => e.session !== 's-other' && e.question === 'Question c1?')
        assert.deepEqual(ours.replaces, ['s-other-1'], 'a later answer to the same question replaces the earlier')
        assert.ok(!('replaces' in answers[0]), 'the earlier entry is untouched')
        // The fields section is rebuilt: Problem is fed by the standing entry, not the replaced one.
        assert.deepEqual(log.fields['background.problem'].entries, [ours.id])
      })
    )
  })
})

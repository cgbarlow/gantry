import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance, readModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'

// #286 (parent #238): the Interview page, end to end, on a server workspace and on a Local workspace. A real server and
// relay, a real Chromium page, and a stand-in for Anthropic that plays a scripted interview: it opens with a summary, drafts
// every Field the SOAP needs (one with an unsourced figure that is sent back once), then chats. Everything the AI is sent
// is recorded so the tests can say what it did and did not see.

const SLUG = 'my-initiative'

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
    // The page reads the Definition, the bundled skills and every Stage's content before Start is ready; give a busy machine room.
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
    events.push(['content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: 'draft_field', input: {} } }])
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

const CITE = '[Client brief, p. 1](source:client-brief)'
const draft = (id, field, value) => ({ id, input: { field, value } })
const SOAP_DRAFTS = [
  draft('t1', 'background.problem', `Claims take too long to settle ${CITE}.`),
  draft('t2', 'background.affected-domains', ['Claims', 'Member services']),
  draft('t3', 'solution-definition.high-level-requirements', `Members must lodge claims online ${CITE}.`),
  draft('t4', 'solution-definition.high-level-solution-overview', 'Configure the existing claims platform.'),
  draft('t5', 'solution-definition.process-flow', 'A member lodges, an assessor reviews, payment is made.'),
  draft('t6', 'solution-definition.feature-breakdown', 'Lodge a claim. Track its status.'),
  draft('t7', 'team-and-estimates.teams-required', ['Claims', 'Integration']),
]

// `script(body, n, key)` returns { text, tools } for the nth POST /v1/messages.
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
      const key = req.headers['x-api-key'] ?? null
      posts.push({ key, raw, body: JSON.parse(raw) })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(anthropicReply(script(JSON.parse(raw), posts.length - 1, key)))
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

// Two AI Providers in this browser, both already tested (the test connection has its own browser coverage).
function seedProviders(page, aiBase) {
  const passed = { status: 'passed', testedAt: '2026-11-02T00:00:00Z', questionCards: 'native', readsImages: false, steps: [], message: 'ok' }
  const list = [
    { id: 'one', name: 'First AI', type: 'anthropic', address: aiBase, key: 'key-one', model: 'claude-small', isDefault: true, test: passed },
    { id: 'two', name: 'Second AI', type: 'anthropic', address: aiBase, key: 'key-two', model: 'claude-small', isDefault: false, test: passed },
  ]
  return page.addInitScript((value) => localStorage.setItem('gantry:ai-providers', value), JSON.stringify(list))
}

// A distinctive sentence from the example Instance, so we can say it never reached the AI.
function exampleSentence() {
  const text = readFileSync('workspaces/examples/kiwi-cover-mutual/modules/background.md', 'utf8')
  const run = text.match(/[A-Za-z][A-Za-z ]{60,}/)?.[0]
  assert.ok(run, 'the example has a sentence to look for')
  return run.slice(0, 50)
}

const interviewScript = (body, n) => {
  if (n === 0) return { text: 'I found one brief: claims take too long to settle.', tools: [...SOAP_DRAFTS, draft('t8', 'team-and-estimates.estimates', 'Delivery takes 12 weeks.')] }
  if (n === 1) return { tools: [draft('t9', 'team-and-estimates.estimates', 'Delivery takes 12 weeks (target assumption).')] }
  if (n === 2) return { text: 'SOAP is drafted. Who is the sponsor?' }
  return { text: 'Noted: the sponsor is Pat.' }
}

const field = (page, key) => page.locator(`[data-testid="interview-field"][data-field-key="${key}"]`)

// ---------- a server workspace ----------

test('server workspace: start an interview, watch drafts fill the preview, chat, switch AI Provider and save the stage', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-286-'))
  try {
    createInstance('design', SLUG, { instancesDir, definitionVersion: 3 })
    // The example Instance the Stage points at, so the editor's data carries example text the AI must never be sent.
    cpSync('workspaces/examples', join(instancesDir, 'examples'), { recursive: true })
    const sentinel = exampleSentence()

    await withFakeAnthropic(interviewScript, (aiBase, posts) =>
      withRunningServer({ slug: SLUG, instancesDir, allowPrivateAiUrls: true }, (base) =>
        withPage(async (page) => {
          await seedProviders(page, aiBase)
          const puts = []
          page.on('request', (req) => req.method() === 'PUT' && req.url().includes('/api/instance/modules') && puts.push(req.url()))

          // A Source document, added the way the editor's panel does.
          const upload = await fetch(`${base}/api/instance/sources?slug=${SLUG}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: 'Client brief.md', dataBase64: Buffer.from('# Client brief\n\nClaims take 12 days to settle.').toString('base64'), text: '# Client brief\n\nClaims take too long to settle.' }),
          })
          assert.equal(upload.status, 201)

          await page.goto(`${base}/instance/${SLUG}`)
          await page.waitForSelector('.module')
          const exampleInPage = await page.evaluate(async (slug) => JSON.stringify(await (await fetch(`/api/instance?slug=${slug}`)).json()), SLUG)
          assert.ok(exampleInPage.includes(sentinel), 'the editor does carry the example text')

          // Entry: "✦ AI interview" in the editor's header.
          await page.click('[data-testid="open-ai-interview"]')
          await page.waitForSelector('[data-testid="interview-page"]')
          assert.match(page.url(), /interview=1/)

          // Kickoff: the Default AI Provider is pre-selected, the lightest Artefact is pre-selected, the Source document is listed.
          assert.equal(await page.inputValue('[data-testid="interview-provider"]'), 'one')
          assert.equal(await page.inputValue('[data-testid="interview-artefact"]'), 'soap')
          await page.waitForSelector('[data-testid="source-documents-list"] [data-source-id="client-brief"]')
          assert.match(await page.textContent('[data-testid="interview-source-count"]'), /1 Source document/)
          assert.equal(await page.isVisible('[data-testid="interview-chat"]'), true, 'the composer is pinned at the bottom')
          assert.equal(await page.isDisabled('[data-testid="interview-chat"]'), true, 'and waits for the interview to start')

          await page.click('[data-testid="interview-start"]')

          // The AI opens with a summary; drafts land in the preview, marked as unsaved AI drafts.
          await page.waitForSelector('[data-testid="interview-msg"][data-who="ai"]')
          await field(page, 'background.problem').locator('[data-testid="interview-ai-mark"]').waitFor()
          assert.match(await field(page, 'background.problem').textContent(), /AI draft · unsaved/)
          assert.match(await field(page, 'background.problem').textContent(), /Claims take too long to settle/)
          assert.equal(await field(page, 'background.problem').locator('.cite').count(), 1, 'a citation shows as a mark')

          // The over-budget-free but unsourced estimate was sent back once and then accepted.
          await page.waitForSelector('[data-testid="interview-stage-end"]')
          assert.match(await field(page, 'team-and-estimates.estimates').textContent(), /12 weeks \(target assumption\)/)
          assert.equal(await field(page, 'team-and-estimates.estimates').locator('[data-testid="interview-warning"]').count(), 0)
          const sentBack = posts[1].body.messages.at(-1).content.find((b) => b.type === 'tool_result' && b.tool_use_id === 't8')
          assert.equal(sentBack.is_error, true)
          assert.match(sentBack.content, /no source/)

          // Nothing is saved until the card is confirmed.
          assert.equal(puts.length, 0)
          assert.equal(readModule(loadDefinition('design', { definitionsDir: 'definitions', version: 3 }), SLUG, 'background', { instancesDir: join(instancesDir, 'default') }).fields.problem ?? '', '')

          // Free chat, after switching to the other AI Provider between two turns.
          await page.selectOption('[data-testid="interview-switch"]', 'two')
          await page.fill('[data-testid="interview-chat"]', 'The sponsor is Pat.')
          await page.click('[data-testid="interview-send"]')
          await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="interview-msg"][data-who="ai"]')].some((m) => /sponsor is Pat/.test(m.textContent)))
          assert.equal(posts.at(-1).key, 'key-two', 'the next turn went to the second AI Provider')
          assert.equal(posts[0].key, 'key-one')
          assert.ok(posts.at(-1).body.messages.length > posts[2].body.messages.length, 'and it was given the conversation so far')
          assert.match(await page.textContent('[data-testid="interview-thread"]'), /Switched to Second AI/)

          // No example Instance content reached the AI, in any request.
          for (const post of posts) assert.ok(!post.raw.includes(sentinel), 'no request carries example text')

          // Save and stop here: one stage Save, Modules stay draft.
          await page.click('[data-testid="interview-save"]')
          await page.waitForSelector('[data-testid="interview-saved"]')
          assert.equal(puts.length, 1, 'one stage Save')
          assert.match(await page.textContent('[data-testid="interview-saved-gate"]'), /Gate check passes/)
          const design = loadDefinition('design', { definitionsDir: 'definitions', version: 3 })
          const background = readModule(design, SLUG, 'background', { instancesDir: join(instancesDir, 'default') })
          assert.match(background.fields.problem, /Claims take too long to settle \[Client brief, p\. 1\]\(source:client-brief\)\./)
          assert.deepEqual(background.fields['affected-domains'], ['Claims', 'Member services'])
          assert.equal(background.status, 'draft')
          assert.equal(readModule(design, SLUG, 'team-and-estimates', { instancesDir: join(instancesDir, 'default') }).status, 'draft')
          // The preview now shows them as saved content, no longer unsaved drafts.
          assert.equal(await field(page, 'background.problem').getAttribute('data-state'), 'saved')

          // Back in the editor, the saved content is there.
          await page.click('[data-testid="interview-back"]')
          await page.waitForSelector('.module')
          assert.ok(!page.url().includes('interview=1'))
        })
      )
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('server workspace: a Field with saved content is left alone, and an over-budget draft is sent back once then shown with a warning', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-286-'))
  try {
    createInstance('design', SLUG, { instancesDir, definitionVersion: 3 })
    const long = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ')
    const script = (body, n) => {
      if (n === 0) return { text: 'Reading.', tools: [draft('a1', 'background.problem', long), draft('a2', 'background.affected-domains', ['Claims'])] }
      if (n === 1) return { tools: [draft('a3', 'background.problem', `${long} extra`)] }
      return { text: 'Done.' }
    }
    // Saved content in a Field the AI will try to draft.
    const { writeModule } = await import('../lib/instance.js')
    const design = loadDefinition('design', { definitionsDir: 'definitions', version: 3 })
    writeModule(design, SLUG, 'background', { status: 'draft', owner: '', fields: { 'affected-domains': ['Finance'] } }, { instancesDir })

    await withFakeAnthropic(script, (aiBase, posts) =>
      withRunningServer({ slug: SLUG, instancesDir, allowPrivateAiUrls: true }, (base) =>
        withPage(async (page) => {
          await seedProviders(page, aiBase)
          await page.goto(`${base}/instance/${SLUG}?interview=1`)
          await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
          await page.click('[data-testid="interview-start"]')
          await page.waitForFunction(() => document.querySelector('[data-testid="interview-msg"][data-who="ai"]:last-of-type') && !document.querySelector('[data-testid="interview-working"]'))
          // The saved Field is untouched; its draft was refused.
          assert.equal(await field(page, 'background.affected-domains').getAttribute('data-state'), 'saved')
          assert.match(await field(page, 'background.affected-domains').textContent(), /Finance/)
          const refused = posts[1].body.messages.at(-1).content.find((b) => b.tool_use_id === 'a2')
          assert.equal(refused.is_error, true)
          assert.match(refused.content, /already holds saved content/)
          // The long draft went back once, came back long, and shows with a warning.
          const warning = field(page, 'background.problem').locator('[data-testid="interview-warning"]')
          await warning.waitFor()
          assert.match(await warning.textContent(), /over the Medium budget/)
          assert.equal(await field(page, 'background.problem').getAttribute('data-state'), 'draft')
          // The Gate check hasn't passed (most required Fields are empty): no stage-end card.
          assert.equal(await page.locator('[data-testid="interview-stage-end"]').count(), 0)
          assert.match(await page.textContent('[data-testid="interview-gate-line"]'), /not yet/)
        })
      )
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('connecting an AI Provider from the kickoff, and the editor button is off outside the current Stage', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-286-'))
  try {
    createInstance('design', SLUG, { instancesDir, definitionVersion: 3 })
    await withRunningServer({ slug: SLUG, instancesDir, allowPrivateAiUrls: true }, (base) =>
      withPage(async (page) => {
        await page.goto(`${base}/instance/${SLUG}`)
        await page.waitForSelector('.module')
        await page.click('[data-testid="open-ai-interview"]')
        await page.waitForSelector('[data-testid="interview-kickoff"]')
        assert.equal(await page.isVisible('[data-testid="interview-no-provider"]'), true)
        assert.equal(await page.isDisabled('[data-testid="interview-start"]'), true)
        await page.click('[data-testid="interview-connect"]')
        await page.fill('#ai-provider-name', 'Mine')
        await page.selectOption('#ai-provider-type', 'anthropic')
        await page.fill('#ai-provider-key', 'k')
        await page.fill('#ai-provider-model', 'claude-small')
        await page.click('.ai-provider-dialog .btn.primary')
        await page.waitForSelector('[data-testid="interview-provider"]')
        assert.equal(await page.isDisabled('[data-testid="interview-start"]'), false, 'the new AI Provider is the Default and is pre-selected')
        assert.match(await page.textContent('[data-testid="interview-provider-status"]'), /Untested/)

        // Another Stage is not the current one: the button says why it is off.
        await page.click('[data-testid="interview-back"]')
        await page.waitForSelector('.module')
        await page.click('#stage-nav button:not(.stage-current)')
        await page.waitForFunction(() => document.querySelector('[data-testid="open-ai-interview"]')?.disabled === true)
        assert.match(await page.getAttribute('[data-testid="open-ai-interview"]', 'title'), /current Stage/)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

// ---------- a Local workspace ----------

test('local workspace: the same interview reads and saves through the folder, and a Source document added from the rail is read', async () => {
  await withFakeAnthropic(
    (body, n) => (n === 0 ? { text: 'One brief.', tools: SOAP_DRAFTS.concat(draft('t8', 'team-and-estimates.estimates', 'Delivery takes 12 weeks (target assumption).')) } : { text: 'Drafted.' }),
    (aiBase, posts) =>
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

          // "+ Add Source document" in the rail: the text is read in the browser and kept in the folder.
          await page.setInputFiles('[data-testid="source-documents-compact"] [data-testid="source-documents-input"]', {
            name: 'Client brief.md',
            mimeType: 'text/markdown',
            buffer: Buffer.from('# Client brief\n\nClaims take too long to settle.'),
          })
          await page.waitForSelector('[data-testid="source-documents-list"] [data-source-id="client-brief"]')
          await page.waitForFunction(() => /1 Source document/.test(document.querySelector('[data-testid="interview-source-count"]')?.textContent ?? ''))

          await page.click('[data-testid="interview-start"]')
          await page.waitForSelector('[data-testid="interview-stage-end"]')
          assert.match(posts[0].raw, /Claims take too long to settle\./, 'the Source document text went to the AI')
          await page.click('[data-testid="interview-save"]')
          await page.waitForSelector('[data-testid="interview-saved"]')

          const saved = await page.evaluate(async () => {
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
            return readTextFile(await getWorkspaceHandle(all[0].id), 'gantry-workspace/local-int/modules/background.md')
          })
          assert.match(saved, /Claims take too long to settle/)
          assert.match(saved, /status: draft/)
        })
      )
  )
})

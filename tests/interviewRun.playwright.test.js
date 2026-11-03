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

// #293 (parent #238): "Run until stage X" carries one AI interview across Stages on local and server workspaces. A real server
// and relay, a real Chromium page, and a stand-in for Anthropic that drafts the one Field each Stage of a small three-Stage
// Definition needs. The tests walk the whole run: the picker, the run plan, the two buttons of the stage-end card, each Stage
// getting its own decisions log, a pause and a resume (in the same visit and from a reload), and a Local workspace.

const SLUG = 'run-test'

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
  const root = mkdtempSync(join(tmpdir(), 'gantry-293-'))
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
const states = (page) => page.locator('[data-testid="run-plan-row"]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-stage-id')}:${e.getAttribute('data-state')}${e.getAttribute('data-target') === 'true' ? '*' : ''}`))
const waitState = (page, id, state) => page.waitForSelector(`[data-testid="run-plan-row"][data-stage-id="${id}"][data-state="${state}"]`)

// The Instance's folder, whatever the layout: where its instance.yaml is.
function instanceFolder(instancesDir) {
  for (const candidate of [join(instancesDir, 'default', SLUG), join(instancesDir, SLUG)]) if (existsSync(join(candidate, 'instance.yaml'))) return candidate
  throw new Error('no instance folder')
}
const readYaml = (file) => parseYAML(readFileSync(file, 'utf8'))

// ---------- a server workspace ----------

test('server workspace: a run until Ship drafts, saves and advances Scope and Shape, then stops at Done after Ship', async () => {
  await withTrioServer(async ({ page, base, posts, instancesDir }) => {
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-run-until"]')

    // Kickoff: the picker offers this Stage and every later one; this Stage is selected; the plan shows the Stages in order.
    assert.deepEqual(await page.locator('[data-testid="interview-run-until"] option').evaluateAll((els) => els.map((e) => e.value)), ['s1', 's2', 's3'])
    assert.equal(await page.inputValue('[data-testid="interview-run-until"]'), 's1')
    assert.deepEqual(await states(page), ['s1:waiting*', 's2:beyond', 's3:beyond'])
    assert.match(await row(page, 's2').getAttribute('class'), /rp-beyond/)
    assert.equal(await row(page, 's2').evaluate((el) => getComputedStyle(el).textDecorationLine), 'line-through', 'a Stage beyond the target is struck through')

    await page.selectOption('[data-testid="interview-run-until"]', 's3')
    assert.deepEqual(await states(page), ['s1:waiting', 's2:waiting', 's3:waiting*'], 'the plan follows the picker')
    await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    await page.click('[data-testid="interview-start"]')

    // Stage 1: drafting, then the card, with both buttons and the advance one recommended.
    await waitState(page, 's1', 'drafting')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    await waitState(page, 's1', 'awaiting-confirmation')
    assert.deepEqual(await states(page), ['s1:awaiting-confirmation', 's2:waiting', 's3:waiting*'])
    assert.match(await page.textContent('[data-testid="interview-save-advance"]'), /Save, advance, carry on/)
    assert.match(await page.textContent('[data-testid="interview-save-advance"]'), /RECOMMENDED/)
    assert.match(await page.textContent('[data-testid="interview-save"]'), /Save and stop here/)

    // Carry on: one Save, the Instance advances, and the AI starts Shape by itself.
    await page.click('[data-testid="interview-save-advance"]')
    await page.waitForSelector('[data-testid="interview-field"][data-field-key="m2.body"]')
    await waitState(page, 's2', 'awaiting-confirmation')
    assert.deepEqual(await states(page), ['s1:done', 's2:awaiting-confirmation', 's3:waiting*'])
    assert.equal(await page.locator('[data-testid="interview-start"]').count(), 0, 'nobody pressed Start for Shape')
    await page.click('[data-testid="interview-save-advance"]')

    // Stage 3 is the target: one button, and the Save finishes the run.
    await page.waitForSelector('[data-testid="interview-field"][data-field-key="m3.body"]')
    await waitState(page, 's3', 'awaiting-confirmation')
    assert.equal(await page.locator('[data-testid="interview-save-advance"]').count(), 0, 'nothing to carry on to')
    assert.match(await page.textContent('[data-testid="interview-save"]'), /Save and finish the run/)
    await page.click('[data-testid="interview-save"]')
    await page.waitForSelector('[data-testid="interview-run-done"]')
    await waitState(page, 's3', 'done')
    assert.deepEqual(await states(page), ['s1:done', 's2:done', 's3:done*'])
    assert.match(await page.textContent('[data-testid="interview-saved"]'), /the run is done/)

    // On disk: every Stage's Module saved as draft, the Instance at the target Stage, and one decisions log per Stage.
    const folder = instanceFolder(instancesDir)
    assert.equal(readYaml(join(folder, 'instance.yaml')).stage, 's3')
    for (const [stage, mod] of [['s1', 'm1'], ['s2', 'm2'], ['s3', 'm3']]) {
      const text = readFileSync(join(folder, 'modules', `${mod}.md`), 'utf8')
      assert.match(text, new RegExp(`Notes for ${stage}`))
      assert.match(text, /status: draft/)
      const log = readYaml(join(folder, 'interview', `${stage}.yaml`))
      assert.equal(log.stage, stage)
      assert.equal(log.status.length, 1, `${stage} has its own session line`)
      assert.equal(log.status[0].target, 's3', 'the run target is recorded')
      assert.ok(Object.keys(log.fields).every((key) => key.startsWith(`${mod}.`)), `${stage}'s log holds only its own Fields`)
    }
    assert.deepEqual([1, 2, 3].map((n) => readYaml(join(folder, 'interview', `s${n}.yaml`)).status[0].state), ['saved', 'saved', 'done'])
    assert.deepEqual(readYaml(join(folder, 'interview', 's1.yaml')).status[0].stages, { s1: 'done', s2: 'waiting', s3: 'waiting' })
    assert.deepEqual(readYaml(join(folder, 'interview', 's3.yaml')).status[0].stages, { s1: 'done', s2: 'done', s3: 'done' })

    // Stage order: Scope's brief had no Shape content, and each Stage was drafted once, in order.
    assert.deepEqual(posts.map((p) => stageOf(p.body)).filter((s, i, all) => s !== all[i - 1]), ['s1', 's2', 's3'])
    assert.ok(posts.every((p) => p.key === 'key-one'), 'the whole run used the AI Provider picked at the kickoff')
  })
})

test('server workspace: Save and stop here pauses the run, Resume carries on, and a reload finds the paused run from the decisions log', async () => {
  await withTrioServer(async ({ page, base, instancesDir }) => {
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-run-until"]')
    await page.selectOption('[data-testid="interview-run-until"]', 's3')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')

    // Save and stop here: saved, paused, and the Instance has not moved.
    await page.click('[data-testid="interview-save"]')
    await page.waitForSelector('[data-testid="interview-run-paused"]')
    await waitState(page, 's1', 'paused')
    assert.deepEqual(await states(page), ['s1:paused', 's2:waiting', 's3:waiting*'])
    const folder = instanceFolder(instancesDir)
    assert.equal(readYaml(join(folder, 'instance.yaml')).stage, 's1')
    const paused = readYaml(join(folder, 'interview', 's1.yaml')).status[0]
    assert.deepEqual([paused.target, paused.state], ['s3', 'paused'])
    assert.deepEqual(paused.stages, { s1: 'paused', s2: 'waiting', s3: 'waiting' })

    // Resume, in the same visit: the run advances and Shape starts by itself.
    await page.click('[data-testid="interview-resume"]')
    await page.waitForSelector('[data-testid="interview-field"][data-field-key="m2.body"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    assert.deepEqual(await states(page), ['s1:done', 's2:awaiting-confirmation', 's3:waiting*'])
    assert.equal(readYaml(join(folder, 'instance.yaml')).stage, 's2')

    // Pause again at Shape, then reload: the tab forgets the run, the decisions log remembers it.
    await page.click('[data-testid="interview-save"]')
    await page.waitForSelector('[data-testid="interview-run-paused"]')
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-resume-note"]')
    assert.match(await page.textContent('[data-testid="interview-resume-note"]'), /run to Ship was paused after Shape was saved/)
    assert.equal(await page.inputValue('[data-testid="interview-run-until"]'), 's2', 'a reload does not change the picker; Resume does')
    await page.click('[data-testid="interview-resume"]')

    // Ship starts by itself, with the run's target, and is the last Stage.
    await page.waitForSelector('[data-testid="interview-field"][data-field-key="m3.body"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    assert.deepEqual(await states(page), ['s1:done', 's2:done', 's3:awaiting-confirmation*'])
    await page.click('[data-testid="interview-save"]')
    await page.waitForSelector('[data-testid="interview-run-done"]')
    assert.equal(readYaml(join(folder, 'instance.yaml')).stage, 's3')
    assert.equal(readYaml(join(folder, 'interview', 's3.yaml')).status[0].state, 'done')
  })
})

test('server workspace: a run of one Stage is unchanged: one button, Done after the Save, and the Instance does not move', async () => {
  await withTrioServer(async ({ page, base, instancesDir }) => {
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-run-until"]')
    // The default is this Stage only: one button, "Save and stop here", and the run is Done after the Save.
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    assert.equal(await page.locator('[data-testid="interview-save-advance"]').count(), 0)
    assert.deepEqual(await states(page), ['s1:awaiting-confirmation*', 's2:beyond', 's3:beyond'])
    assert.match(await page.textContent('[data-testid="interview-save"]'), /Save and stop here/)
    await page.click('[data-testid="interview-save"]')
    await page.waitForSelector('[data-testid="interview-saved"]')
    assert.equal(await page.locator('[data-testid="interview-run-paused"]').count(), 0, 'a run of one Stage is done, not paused')
    await waitState(page, 's1', 'done')
    const folder = instanceFolder(instancesDir)
    assert.equal(readYaml(join(folder, 'instance.yaml')).stage, 's1', 'and the Instance has not moved')
    assert.equal(readYaml(join(folder, 'interview', 's1.yaml')).status[0].state, 'done')
  })
})

test('server workspace: a run that cannot advance stays paused with the reason until it can', async () => {
  await withTrioServer(async ({ page, base, instancesDir }) => {
    // The server refuses the advance, as it does while the Gate does not pass.
    await page.route('**/api/instance/advance-stage*', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: 'The Gate has not passed' }) }))
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-run-until"]')
    await page.selectOption('[data-testid="interview-run-until"]', 's2')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    await page.click('[data-testid="interview-save-advance"]')
    // The Save has happened; the run is paused here and says why.
    await page.waitForSelector('[data-testid="interview-advance-error"]')
    assert.match(await page.textContent('[data-testid="interview-advance-error"]'), /The Gate has not passed/)
    await waitState(page, 's1', 'paused')
    const folder = instanceFolder(instancesDir)
    assert.match(readFileSync(join(folder, 'modules', 'm1.md'), 'utf8'), /Notes for s1/)
    assert.equal(readYaml(join(folder, 'instance.yaml')).stage, 's1')

    // Once it can advance, Resume carries on.
    await page.unroute('**/api/instance/advance-stage*')
    await page.click('[data-testid="interview-resume"]')
    await page.waitForSelector('[data-testid="interview-field"][data-field-key="m2.body"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    assert.deepEqual(await states(page), ['s1:done', 's2:awaiting-confirmation*', 's3:beyond'])
  })
})

// ---------- a Local workspace ----------

test('local workspace: a run until Shape drafts, saves and advances Scope, then stops at Done after Shape', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gantry-293-'))
  const definitionsDir = join(root, 'definitions')
  try {
    writeTrio(definitionsDir)
    await withFakeAnthropic(runScript, (aiBase, posts) =>
      withRunningServer({ definitionsDir, allowPrivateAiUrls: true }, (base) =>
        withPage(async (page) => {
          await seedProviders(page, aiBase)
          await page.goto(`${base}/settings`)
          const workspaceId = await page.evaluate(async () => {
            const { rememberWorkspace } = await import('/lib/localWorkspace.js')
            const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('local-ws-' + Date.now(), { create: true })
            const sub = await (await dir.getDirectoryHandle('gantry-workspace', { create: true })).getDirectoryHandle('local-run', { create: true })
            const w = await (await sub.getFileHandle('instance.yaml', { create: true })).createWritable()
            await w.write('definition: trio\nslug: local-run\nstage: s1\nassignee: a.architect\ndefinitionVersion: 1\n')
            await w.close()
            return rememberWorkspace({ handle: dir, name: 'Local Run Workspace' })
          })
          await page.goto(`${base}/instance/local-run?local=${encodeURIComponent(workspaceId)}&interview=1`)
          await page.waitForSelector('[data-testid="interview-run-until"]')
          await page.selectOption('[data-testid="interview-run-until"]', 's2')
          assert.deepEqual(await states(page), ['s1:waiting', 's2:waiting*', 's3:beyond'])
          await page.click('[data-testid="interview-start"]')
          await page.waitForSelector('[data-testid="interview-stage-end"]')
          await page.click('[data-testid="interview-save-advance"]')
          await page.waitForSelector('[data-testid="interview-field"][data-field-key="m2.body"]')
          await page.waitForSelector('[data-testid="interview-stage-end"]')
          assert.deepEqual(await states(page), ['s1:done', 's2:awaiting-confirmation*', 's3:beyond'])
          assert.equal(await page.locator('[data-testid="interview-save-advance"]').count(), 0)
          await page.click('[data-testid="interview-save"]')
          await page.waitForSelector('[data-testid="interview-run-done"]')

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
            const read = (path) => readTextFile(handle, `gantry-workspace/local-run/${path}`)
            return { instance: await read('instance.yaml'), m1: await read('modules/m1.md'), m2: await read('modules/m2.md'), log1: await read('interview/s1.yaml'), log2: await read('interview/s2.yaml') }
          })
          assert.match(files.instance, /stage: s2/)
          assert.match(files.m1, /Notes for s1/)
          assert.match(files.m2, /Notes for s2/)
          assert.equal(parseYAML(files.log1).status[0].state, 'saved')
          assert.equal(parseYAML(files.log1).status[0].target, 's2')
          assert.equal(parseYAML(files.log2).status[0].state, 'done')
          assert.deepEqual(parseYAML(files.log2).status[0].stages, { s1: 'done', s2: 'done' })
        })
      )
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

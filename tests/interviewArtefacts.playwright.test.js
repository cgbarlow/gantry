import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'
import { writeTrio } from './helpers/trioDefinition.js'
import { seedProviders, trioStageOf, withFakeAnthropic } from './helpers/interviewStandIn.js'
import { PROVIDERS, ROOT, SLUG as REMOTE_SLUG, open as openRemote, withRemoteTrio } from './helpers/remoteTrio.js'
import { stageBranchName } from '../lib/stageBranch.js'

// #332: the kickoff's "Artefact for each Stage", and each Stage of a run aiming for the Artefact chosen for it. A real server and relay, a real
// Chromium page and a stand-in for Anthropic, on the three-Stage trio where Shape's Gate can be passed by two Artefacts (`writeTrio`'s
// `choice`): "Shape document" (the lightest) and "Shape document (full)", which also needs Shape's `more`. The rows themselves and the status
// block are covered under node --test in tests/interviewRun.test.js; this is the screen, the run, a fresh browser, and drafting ahead on GitHub.

const SLUG = 'artefacts-test'
const MODULE = { s1: 'm1', s2: 'm2', s3: 'm3' }
const FULL = 'art-s2-full'

// The first turn of a Stage drafts its Field (Shape also drafts `more`, which the full document needs); the turn after is a short reply.
const script = (body) => {
  const stage = trioStageOf(body)
  if (body.messages.every((m) => m.role === 'user')) {
    const tools = [{ id: `d-${stage}`, input: { field: `${MODULE[stage]}.body`, value: `Notes for ${stage}: the agreed position, written out.` } }]
    if (stage === 's2') tools.push({ id: 'd-s2-more', input: { field: 'm2.more', value: 'More for s2: what the full document adds.' } })
    return { text: `Reading for ${stage}.`, tools }
  }
  return { text: `${stage} is drafted.` }
}

// The first request the AI got for each Stage, in order, and the Artefact its brief aims for.
const firstRequests = (posts) => posts.filter((p) => p.body.messages.every((m) => m.role === 'user')).map((p) => ({ stage: trioStageOf(p.body), body: p.body }))
const aimedFor = (request) => JSON.stringify(request.body.system ?? '').match(/Artefact aimed for:\*\* .*? \(`([\w-]+)`\)/)?.[1] ?? null
async function waitForRequests(posts, count) {
  for (let i = 0; i < 120 && firstRequests(posts).length < count; i++) await new Promise((resolve) => setTimeout(resolve, 250))
  assert.equal(firstRequests(posts).length, count, `the AI was asked to open ${count} Stage sessions`)
  return firstRequests(posts)
}

const readYaml = (file) => parseYAML(readFileSync(file, 'utf8'))
function instanceFolder(instancesDir) {
  for (const candidate of [join(instancesDir, 'default', SLUG), join(instancesDir, SLUG)]) if (existsSync(join(candidate, 'instance.yaml'))) return candidate
  throw new Error('no instance folder')
}

// A browser; `open()` gives a page in a fresh browser profile each time (its own storage), with the stand-in AI Provider in it.
async function withBrowser(aiBase, fn) {
  const browser = await launchBrowser()
  const pageErrors = []
  try {
    const open = async () => {
      const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } })
      const page = await context.newPage()
      page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
      page.on('pageerror', (err) => pageErrors.push(err.message))
      await seedProviders(page, aiBase)
      return page
    }
    await fn(open)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

async function withChoiceServer(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-332-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  try {
    writeTrio(definitionsDir, { choice: true })
    mkdirSync(instancesDir)
    createInstance('trio', SLUG, { instancesDir, definitionsDir, definitionVersion: 1 })
    await withFakeAnthropic(script, (aiBase, posts) =>
      withRunningServer({ slug: SLUG, instancesDir, definitionsDir, allowPrivateAiUrls: true }, (base) => withBrowser(aiBase, (open) => fn({ open, base, posts, instancesDir })))
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// Each row of the block as `stage | label | value | disabled | options`.
const rows = (page) =>
  page.locator('[data-testid="interview-artefact-row"]').evaluateAll((els) =>
    els.map((row) => {
      const select = row.querySelector('select')
      return [row.getAttribute('data-stage-id'), row.querySelector('label').textContent, select.value, select.disabled, [...select.options].map((o) => o.textContent).join(' / ')]
    })
  )
const pick = (page, stageId, artefactId) => page.selectOption(`[data-testid="interview-artefact"][data-stage-id="${stageId}"]`, artefactId)

test('server workspace: the kickoff has a row per Stage of the run, and each Stage the run carries on into aims for the Artefact chosen for it, after a Pause in a fresh browser too', async () => {
  await withChoiceServer(async ({ open, base, posts, instancesDir }) => {
    const page = await open()
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-artefacts"]')
    assert.equal(await page.textContent('[data-testid="interview-artefacts"] legend'), 'Artefact for each Stage')
    // A run of one Stage still shows its row, ghosted when only one Artefact can pass the Gate.
    assert.deepEqual(await rows(page), [['s1', 'Scope (gate: g1)', 'art-s1', true, 'Scope document']])
    assert.equal(await page.getAttribute('[data-testid="interview-artefact"][data-stage-id="s1"]', 'title'), 'Only one Artefact can pass this Gate')
    assert.ok(
      await page.evaluate(() => {
        const runUntil = document.querySelector('[data-testid="interview-run-until"]')
        const block = document.querySelector('[data-testid="interview-artefacts"]')
        return Boolean(runUntil.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING)
      }),
      'the block sits under Run until'
    )
    assert.doesNotMatch(await page.textContent('[data-testid="interview-run-until-note"]'), /lightest/)

    // Picking a later Stage adds a row per Stage in between; Shape has a choice, with the lightest pre-selected.
    await page.selectOption('[data-testid="interview-run-until"]', 's3')
    assert.deepEqual(await rows(page), [
      ['s1', 'Scope (gate: g1)', 'art-s1', true, 'Scope document'],
      ['s2', 'Shape (gate: g2)', 'art-s2', false, 'Shape document (lightest) / Shape document (full)'],
      ['s3', 'Ship (gate: g3)', 'art-s3', true, 'Ship document'],
    ])
    // A choice is kept for a Stage that stays, and comes back with it.
    await pick(page, 's2', FULL)
    await page.selectOption('[data-testid="interview-run-until"]', 's2')
    assert.deepEqual((await rows(page)).map((r) => [r[0], r[2]]), [['s1', 'art-s1'], ['s2', FULL]])
    await page.selectOption('[data-testid="interview-run-until"]', 's1')
    assert.deepEqual((await rows(page)).map((r) => r[0]), ['s1'])
    await page.selectOption('[data-testid="interview-run-until"]', 's2')
    assert.deepEqual((await rows(page)).map((r) => [r[0], r[2]]), [['s1', 'art-s1'], ['s2', FULL]])

    await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    // Save, advance, carry on: Shape starts by itself, aiming for the full document.
    await page.click('[data-testid="interview-save-advance"]')
    await page.waitForSelector('[data-testid="interview-field"][data-field-key="m2.more"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    const [scope, shape] = await waitForRequests(posts, 2)
    assert.deepEqual([scope.stage, aimedFor(scope)], ['s1', 'art-s1'])
    assert.deepEqual([shape.stage, aimedFor(shape)], ['s2', FULL], 'Shape aims for the Artefact chosen for it, not the lightest')

    // Pause on Shape. Its status block records what it aims for and what the run chose for each Stage.
    await page.click('[data-testid="interview-pause"]')
    await page.waitForSelector('[data-testid="interview-paused"]')
    const folder = instanceFolder(instancesDir)
    const shapeStatus = readYaml(join(folder, 'interview', 's2.yaml')).status.at(-1)
    assert.equal(shapeStatus.artefact, FULL)
    assert.deepEqual(shapeStatus.artefacts, { s1: 'art-s1', s2: FULL })
    assert.deepEqual(readYaml(join(folder, 'interview', 's1.yaml')).status.at(-1).artefacts, { s1: 'art-s1', s2: FULL })
    await page.close()

    // A fresh browser knows the choice only from the decisions log: the row comes back with it, and the resumed session aims for it.
    const second = await open()
    await second.goto(`${base}/instance/${SLUG}?interview=1`)
    await second.waitForSelector('[data-testid="interview-resume-recap"]')
    assert.deepEqual((await rows(second)).map((r) => [r[0], r[2]]), [['s2', FULL]])
    await second.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    await second.click('[data-testid="interview-start"]')
    const resumed = (await waitForRequests(posts, 3))[2]
    assert.deepEqual([resumed.stage, aimedFor(resumed)], ['s2', FULL])
  })
})

test('server workspace: a run stopped after a Stage and resumed in a fresh browser aims the next Stage at the Artefact chosen for it', async () => {
  await withChoiceServer(async ({ open, base, posts }) => {
    const first = await open()
    await first.goto(`${base}/instance/${SLUG}?interview=1`)
    await first.waitForSelector('[data-testid="interview-run-until"]')
    await first.selectOption('[data-testid="interview-run-until"]', 's2')
    await pick(first, 's2', FULL)
    await first.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    await first.click('[data-testid="interview-start"]')
    await first.waitForSelector('[data-testid="interview-stage-end"]')
    await first.click('[data-testid="interview-save"]')
    await first.waitForSelector('[data-testid="interview-run-paused"]')
    await first.close()

    const second = await open()
    await second.goto(`${base}/instance/${SLUG}?interview=1`)
    await second.waitForSelector('[data-testid="interview-resume-note"]')
    await second.waitForSelector('[data-testid="interview-resume"]:not([disabled])')
    await second.click('[data-testid="interview-resume"]')
    await second.waitForSelector('[data-testid="interview-field"][data-field-key="m2.more"]')
    const shape = (await waitForRequests(posts, 2))[1]
    assert.deepEqual([shape.stage, aimedFor(shape)], ['s2', FULL])
  })
})

// ---------- a GitHub workspace ----------

const github = PROVIDERS.find((p) => p.provider === 'github')

test('GitHub: drafting ahead aims the next Stage at the Artefact chosen for it', async () => {
  await withRemoteTrio(
    github,
    async ({ page, base, posts, client, api }) => {
      await openRemote(page, base)
      await page.waitForSelector('[data-testid="interview-run-until"]')
      await page.selectOption('[data-testid="interview-run-until"]', 's2')
      await pick(page, 's2', FULL)
      await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
      await page.click('[data-testid="interview-start"]')
      await page.waitForSelector('[data-testid="interview-stage-end"]')
      await page.click('[data-testid="interview-save-approval"]')

      // The session moves on to Shape while Scope awaits approval, and Shape's brief aims for the full document.
      await page.waitForSelector('[data-testid="interview-field"][data-field-key="m2.more"]')
      assert.equal((await (await api('/api/instance')).json()).currentStageId, 's1', 'the Instance stays on Scope')
      const [scope, shape] = await waitForRequests(posts, 2)
      assert.deepEqual([scope.stage, aimedFor(scope)], ['s1', 'art-s1'])
      assert.deepEqual([shape.stage, aimedFor(shape)], ['s2', FULL])
      // Scope's Save, on its own branch, recorded the run's choices, so the run resumed elsewhere keeps them.
      const scopeLog = parseYAML(await client.getFileContent(`${ROOT}/interview/s1.yaml`, { branch: stageBranchName(REMOTE_SLUG, 's1') }))
      assert.deepEqual(scopeLog.status.at(-1).artefacts, { s1: 'art-s1', s2: FULL })
    },
    { choice: true, script }
  )
})

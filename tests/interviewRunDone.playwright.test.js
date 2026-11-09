import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { writeTrio } from './helpers/trioDefinition.js'
import { seedProviders, trioScript, withFakeAnthropic } from './helpers/interviewStandIn.js'
import { PROVIDERS, open, withRemoteTrio } from './helpers/remoteTrio.js'

// #355: once the interview's run is done (its target Stage saved), the bar under the thread offers the next steps, Open in the editor and
// Re-open <Stage>, in place of Pause and Finish with your recommendations, and the chat box is disabled with a line that says so. A real
// server and relay, a real Chromium page and a stand-in for Anthropic that drafts the one Field each Stage of the three-Stage trio needs
// (tests/helpers/trioDefinition.js). tests/interviewRun.test.js covers the rule for "the run is done" (`runIsDone`).

const SLUG = 'done-run'

async function withLocalTrio(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-355-'))
  const definitionsDir = join(root, 'definitions')
  try {
    writeTrio(definitionsDir)
    await withFakeAnthropic(trioScript, (aiBase, posts) =>
      withRunningServer({ definitionsDir, allowPrivateAiUrls: true }, async (base) => {
        const browser = await launchBrowser()
        try {
          const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
          page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
          const pageErrors = []
          page.on('pageerror', (err) => pageErrors.push(err.message))
          await seedProviders(page, aiBase)
          await page.goto(`${base}/settings`)
          const workspaceId = await page.evaluate(async (slug) => {
            const { rememberWorkspace } = await import('/lib/localWorkspace.js')
            const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('local-ws-' + Date.now(), { create: true })
            const sub = await (await dir.getDirectoryHandle('gantry-workspace', { create: true })).getDirectoryHandle(slug, { create: true })
            const w = await (await sub.getFileHandle('instance.yaml', { create: true })).createWritable()
            await w.write(`definition: trio\nslug: ${slug}\nstage: s1\nassignee: a.architect\ndefinitionVersion: 1\n`)
            await w.close()
            return rememberWorkspace({ handle: dir, name: 'Done Run Workspace' })
          }, SLUG)
          const interviewUrl = `${base}/instance/${SLUG}?local=${encodeURIComponent(workspaceId)}&interview=1`
          await page.goto(interviewUrl)
          await fn({ page, base, posts, interviewUrl })
          assert.deepEqual(pageErrors, [])
        } finally {
          await browser.close()
        }
      })
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const count = (page, testId) => page.locator(`[data-testid="${testId}"]`).count()
const focusedTestId = (page) => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? null)

// What the bar under the thread is offering: the run's controls, or the next steps once the run is done.
async function assertDoneBar(page, { stageTitle = 'Shape', reopen = true } = {}) {
  await page.waitForSelector('[data-testid="interview-done-bar"]')
  assert.equal(await count(page, 'interview-pause'), 0, 'nothing left to pause')
  assert.equal(await count(page, 'interview-finish'), 0, 'nothing left to finish')
  assert.equal(await page.textContent('[data-testid="interview-open-editor"]'), 'Open in the editor')
  assert.match(await page.getAttribute('[data-testid="interview-open-editor"]', 'class'), /\bprimary\b/, 'Open in the editor is the primary next step')
  assert.equal(await page.getAttribute('[data-testid="interview-open-editor"]', 'href'), await page.getAttribute('[data-testid="interview-back"]', 'href'), 'the same place ← Editor goes')
  assert.equal(await count(page, 'interview-reopen'), reopen ? 1 : 0)
  if (reopen) assert.equal((await page.textContent('[data-testid="interview-reopen"]')).trim(), `Re-open ${stageTitle}`)
  assert.equal(await page.isDisabled('[data-testid="interview-chat"]'), true, 'the chat box is disabled')
  assert.equal(await page.isDisabled('[data-testid="interview-send"]'), true)
  const line = await page.textContent('[data-testid="interview-done-line"]')
  assert.match(line, /saved and the run is done/)
  if (reopen) assert.match(line, new RegExp(`Re-open ${stageTitle}`), 'the line says how to change something')
  assert.equal(await page.getAttribute('[data-testid="interview-chat"]', 'aria-describedby'), 'interview-done-line', 'the chat box is described by the line')
  // The done state is announced once, in the thread's status region.
  assert.equal(await page.locator('.interview-status [data-testid="interview-done-announce"]').count(), 1)
  assert.match(await page.textContent('[data-testid="interview-done-announce"]'), /The run is done/)
}

test('local workspace: a run done at its target offers Open in the editor and Re-open, the same after a reload, and Re-open starts the Stage again', async () => {
  await withLocalTrio(async ({ page, interviewUrl, posts }) => {
    // A run until Shape: Scope is saved and the run carries on, then Shape, its target, is saved and the run is done.
    await page.waitForSelector('[data-testid="interview-run-until"]')
    await page.selectOption('[data-testid="interview-run-until"]', 's2')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    // While the run is going, the bar has its controls.
    assert.equal(await count(page, 'interview-pause'), 1)
    assert.equal(await count(page, 'interview-finish'), 1)
    assert.equal(await count(page, 'interview-done-bar'), 0)
    await page.click('[data-testid="interview-save-advance"]')
    await page.waitForSelector('[data-testid="interview-field"][data-field-key="m2.body"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    assert.equal(await count(page, 'interview-done-bar'), 0, 'a Stage before the target is not the end of the run')
    await page.click('[data-testid="interview-save"]')
    await page.waitForSelector('[data-testid="interview-run-done"]')

    await assertDoneBar(page)
    // Keyboard: the Save button that was pressed has gone, so the focus moves to the first next step, and Tab reaches the other.
    assert.equal(await focusedTestId(page), 'interview-open-editor')
    await page.keyboard.press('Tab')
    assert.equal(await focusedTestId(page), 'interview-reopen')

    // A reload shows the same done bar, with the done card in place of the kickoff, and the run plan shows Shape as done.
    await page.goto(interviewUrl)
    await assertDoneBar(page)
    await page.waitForSelector('[data-testid="interview-done"]')
    assert.match(await page.textContent('[data-testid="interview-done"]'), /The run is done/)
    assert.equal(await count(page, 'interview-start'), 0, 'no kickoff: the run is done')
    await page.waitForSelector('[data-testid="run-plan-row"][data-stage-id="s2"][data-state="done"]')

    // Re-open Shape: the kickoff comes back, to interview the Stage again from what is saved, and the done bar goes.
    await page.click('[data-testid="interview-reopen"]')
    await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    assert.equal(await count(page, 'interview-done-bar'), 0)
    assert.equal(await count(page, 'interview-done'), 0)
    assert.match(await page.textContent('[data-testid="interview-start"]'), /Resume/, 'it carries on from the decisions log')
    const asked = posts.length
    await page.click('[data-testid="interview-start"]')
    await page.waitForFunction(() => document.querySelector('[data-testid="interview-thread"]')?.textContent.includes('s2 is drafted.'))
    assert.ok(JSON.stringify(posts[asked].body.messages[0]).includes('Resume the interview'), 'the new session resumes from the log')
    assert.equal(await count(page, 'interview-pause'), 1, 'the new session has its run controls')
    assert.equal(await count(page, 'interview-finish'), 1)
    assert.equal(await count(page, 'interview-done-bar'), 0)
    assert.equal(await page.isDisabled('[data-testid="interview-chat"]'), false)

    // Nothing was saved since, so the run is still done: a reload shows the done bar again, and Open in the editor goes to this Instance's editor.
    await page.goto(interviewUrl)
    await assertDoneBar(page)
    await page.click('[data-testid="interview-open-editor"]')
    await page.waitForFunction(() => !new URLSearchParams(location.search).has('interview'))
    assert.equal(await count(page, 'interview-page'), 0)
    assert.match(page.url(), new RegExp(`/instance/${SLUG}\\?local=`))
  })
})

test('local workspace: a run paused before a later Stage keeps Resume the run and its controls, with no done bar', async () => {
  await withLocalTrio(async ({ page }) => {
    await page.waitForSelector('[data-testid="interview-run-until"]')
    await page.selectOption('[data-testid="interview-run-until"]', 's2')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    await page.click('[data-testid="interview-save"]')
    await page.waitForSelector('[data-testid="interview-run-paused"]')
    assert.equal(await count(page, 'interview-resume'), 1)
    assert.equal(await count(page, 'interview-done-bar'), 0)
    assert.equal(await count(page, 'interview-done-announce'), 0)
    assert.equal(await count(page, 'interview-pause'), 1)
    assert.equal(await page.isDisabled('[data-testid="interview-chat"]'), false)
  })
})

test('remote workspace: a run done at its target whose approval is refused keeps the card\'s Request approval, with no run controls', async () => {
  await withRemoteTrio(PROVIDERS[1], async ({ page, base }) => {
    await page.route('**/api/instance/request-approval*', (route) =>
      route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ message: 'The Provider is down for maintenance' }) })
    )
    await open(page, base)
    await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-stage-end"]')
    await page.click('[data-testid="interview-save-approval"]')
    await page.waitForSelector('[data-testid="interview-approval-error"]')
    await page.waitForSelector('[data-testid="interview-request-approval"]')
    // The card's own action stays; the bar has no run controls, and Re-open waits for approval to settle the Stage.
    await assertDoneBar(page, { stageTitle: 'Scope', reopen: false })
    assert.match(await page.textContent('[data-testid="interview-done-line"]'), /approval/)

    // Asked again, the Pull Request opens: the card says it is awaiting approval, and the bar still has no run controls.
    await page.unroute('**/api/instance/request-approval*')
    await page.click('[data-testid="interview-request-approval"]')
    await page.waitForSelector('[data-testid="interview-awaiting-approval"]')
    await assertDoneBar(page, { stageTitle: 'Scope', reopen: false })
  })
})

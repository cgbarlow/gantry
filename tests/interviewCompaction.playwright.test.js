import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'
import { writeTrio } from './helpers/trioDefinition.js'
import { seedProviders, withFakeAnthropic } from './helpers/interviewStandIn.js'

// #329 (docs/adr/0073): Compact now in the rail's Tokens block, end to end. A real server and relay, a real Chromium page and a stand-in for
// Anthropic, on the three-Stage trio. What goes into the new conversation, the card at 60% of the window and a too-long refusal are covered
// under node --test in tests/interviewCompaction.test.js; this is the screen: the button, the wait for the round, the thread line, and the
// interview carrying on to its next round.

const SLUG = 'compaction-test'
const SUMMARY = 'SUMMARY: Scope is drafted from the brief; the scope question is answered; next, ask about the rollout.'
const ask = (id, questions) => ({ id, name: 'ask_architect', input: { questions } })
const qcard = (id) => ({ id, header: `Topic ${id}`, question: `Question ${id}?`, options: [{ label: `${id} yes`, description: 'Say yes' }, { label: `${id} no`, description: 'Say no' }], recommended: `${id} yes`, why: `Because ${id}.` })

const isSummary = (body) => JSON.stringify(body.messages).includes('where we are')
const isCompacted = (body) => JSON.stringify(body.messages).includes('Gantry has compacted this conversation')

// The first turn drafts Scope's Field and asks one card. The summary call is answered with the summary; the compacted conversation asks round 2.
const script = (body) => {
  if (isSummary(body)) return { text: SUMMARY }
  if (isCompacted(body)) return { text: 'Carrying on.', tools: [ask('a2', [qcard('rollout')])] }
  return { text: 'Reading for s1.', tools: [{ id: 'd-s1', input: { field: 'm1.body', value: 'Notes for s1: the agreed position, written out.' } }, ask('a1', [qcard('scope')])] }
}

async function withTrioServer(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-329-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  try {
    writeTrio(definitionsDir)
    mkdirSync(instancesDir)
    createInstance('trio', SLUG, { instancesDir, definitionsDir, definitionVersion: 1 })
    await withFakeAnthropic(script, (aiBase, posts) =>
      withRunningServer({ slug: SLUG, instancesDir, definitionsDir, allowPrivateAiUrls: true }, async (base) => {
        const browser = await launchBrowser()
        const pageErrors = []
        try {
          const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
          page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
          page.on('pageerror', (err) => pageErrors.push(err.message))
          await seedProviders(page, aiBase)
          await fn({ page, base, posts })
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

test('Compact now in the rail waits for the open round, then the thread shows the line and the interview carries on to its next round', async () => {
  await withTrioServer(async ({ page, base, posts }) => {
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-round"][data-round="1"]')
    const threadBefore = await page.locator('[data-testid="interview-msg"]').allTextContents()

    // A round is open, so Compact now waits for it.
    await page.click('[data-testid="interview-tokens"] [data-testid="interview-compact"]')
    assert.match(await page.textContent('[data-testid="interview-compact-pending"]'), /Compacts once you answer this round\./)
    assert.equal(posts.length, 1, 'nothing is sent while the round is open')

    await page.click('[data-testid="round-submit"]')
    await page.waitForSelector('[data-testid="interview-round"][data-round="2"]')
    const thread = await page.locator('[data-testid="interview-msg"]').allTextContents()
    assert.deepEqual(thread.slice(0, threadBefore.length), threadBefore, 'the thread is as it was')
    const lines = thread.filter((t) => /^Conversation compacted \(/.test(t))
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^Conversation compacted \(\d[\d.]*k? → \d[\d.]*k? tokens\)$/)
    assert.match(await page.textContent('[data-testid="interview-round"]'), /Topic rollout/, 'the next round')
    assert.equal(await page.locator('[data-testid="interview-compact-pending"]').count(), 0)
    assert.equal(await page.locator('[data-testid="interview-compact"]').count(), 1, 'Compact now is there again')
    assert.equal(await page.locator('[data-testid="interview-field"][data-field-key="m1.body"]').count(), 1, 'the draft is still in the preview')

    // The summary was asked for in one call with no tools; the next request carried it and none of the old history.
    assert.equal(posts.length, 3)
    const [, summaryCall, next] = posts.map((p) => p.body)
    assert.ok(isSummary(summaryCall))
    assert.ok(!summaryCall.tools?.length)
    assert.ok(JSON.stringify(next.messages).includes(SUMMARY))
    assert.ok(!JSON.stringify(next.messages).includes('tool_use'))
    assert.ok(!JSON.stringify(next.messages).includes('Reading for s1.'))
  })
})

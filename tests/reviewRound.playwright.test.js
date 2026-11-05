import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { showSourcesAndDecisions } from './helpers/referenceView.js'
import { withRunningServer, withScratchInstances } from './helpers/lifecycle.js'
import { seedProviders, withFakeAnthropic } from './helpers/interviewStandIn.js'
import { RENDER_PROPERTIES, reviewedCopy } from './helpers/reviewedCopyFixture.js'
import { readPackageTexts } from '../web/lib/definitionLogo.js'

// #303 (parent #238, decided in #251): review comments as a focused interview round, on a server workspace. A real server and relay, a real
// Chromium page and a stand-in for Anthropic. The rules (which comment is a card, the recommendation, what an answer means, no real name to the
// AI) are covered under node --test in tests/reviewRound.test.js and tests/reviewRoundSession.test.js; this is the screen: the cards, the
// answers, what a Save leaves on disk, the manifest's answered count, the resolved threads, and the questions joining a running interview.

const SLUG = 'acme'
const NAMES = /Ana|Ben|Commenter/

// The wording the fixture document was "rendered" from, so the Fields are unchanged since the render.
const BACKGROUND = `---
module: background
status: draft
owner: ""
---

# Background and context

## Problem statement

We need a new payments platform.

It must support card schemes.

## Opportunity

Reduce cost per transaction.

## Success criteria

Payments Engineering
`

const firstUserText = (body) => {
  const first = body.messages[0]
  return typeof first.content === 'string' ? first.content : first.content.map((b) => b.text ?? '').join('\n')
}
// The stand-in revises whichever Field it is told to revise; every other turn is a short reply.
const script = (body) => {
  const text = firstUserText(body)
  if (body.messages.length === 1) {
    const field = /(background\.[a-z-]+) \([^)]*\): REVISE/.exec(text)?.[1]
    if (field) return { text: `Revising ${field}.`, tools: [{ id: `d-${field}`, input: { field, value: 'Payments Engineering and Risk.' } }] }
    return { text: 'Nothing to ask yet.' }
  }
  return { text: 'Done.' }
}

async function withReviewServer(fn, { copy = true } = {}) {
  await withScratchInstances((instancesDir) =>
    withFakeAnthropic(script, (aiBase, posts) =>
      withRunningServer({ instancesDir, allowPrivateAiUrls: true }, async (base) => {
        const created = await fetch(`${base}/api/instances`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ definition: 'design', slug: SLUG }) })
        assert.equal(created.status, 201)
        const folder = join(instancesDir, 'default', SLUG)
        mkdirSync(join(folder, 'modules'), { recursive: true })
        writeFileSync(join(folder, 'modules', 'background.md'), BACKGROUND)
        let entry = null
        if (copy) {
          const up = await fetch(`${base}/api/instance/reviews?slug=${SLUG}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: [{ filename: 'HLD - Ana and Ben.docx', dataBase64: reviewedCopy({ kind: 'word', properties: { ...RENDER_PROPERTIES, instance: SLUG } }).toString('base64') }] }),
          })
          assert.equal(up.status, 201, await up.clone().text())
          entry = (await up.json()).reviews[0]
        }

        const browser = await launchBrowser()
        try {
          const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
          page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
          const pageErrors = []
          page.on('pageerror', (err) => pageErrors.push(err.message))
          await seedProviders(page, aiBase)
          await fn({ page, base, posts, folder, entry })
          assert.deepEqual(pageErrors, [])
        } finally {
          await browser.close()
        }
      })
    )
  )
}

const cards = (page) => page.locator('[data-testid="interview-card"][data-card-type="review"]')
const cardWith = (page, text) => cards(page).filter({ hasText: text })
const choose = (card, label) => card.locator(`[data-testid="card-option"][data-option="${label}"] input`).check()
const chosenOf = (card) => card.locator('[data-testid="card-option"][data-chosen="true"]').evaluateAll((els) => els.map((el) => el.dataset.option))
const readYaml = (file) => parseYAML(readFileSync(file, 'utf8'))

// Answers every card on the page the same cheap way ("Keep as is" where the card has it, else "Note it"), except those in `except` and a recommended "Accept the edit", which stands.
async function answerPageWith(page, except = new Map()) {
  const shown = await cards(page).count()
  for (let i = 0; i < shown; i++) {
    const card = cards(page).nth(i)
    const text = await card.textContent()
    const special = [...except].find(([needle]) => text.includes(needle))
    if (special) {
      await choose(card, special[1])
      continue
    }
    if ((await chosenOf(card)).includes('Accept the edit')) continue // the recommendation stands
    const labels = await card.locator('[data-testid="card-option"]').evaluateAll((els) => els.map((el) => el.dataset.option))
    await choose(card, labels.includes('Keep as is') ? 'Keep as is' : 'Note it')
  }
}

// Goes through every page of the round, answering each card as `answerPageWith` does, and submits.
async function answerRound(page, except = new Map()) {
  for (;;) {
    await answerPageWith(page, except)
    if ((await page.locator('[data-testid="round-next"]').count()) === 0) break
    await page.click('[data-testid="round-next"]')
  }
  await page.click('[data-testid="round-submit"]')
}

test('server workspace: the review round asks one card per unresolved thread, an accepted edit is made by Gantry, and nothing is saved until the round is', async () => {
  await withReviewServer(async ({ page, base, posts, folder, entry }) => {
    await page.goto(`${base}/instance/${SLUG}`)
    await showSourcesAndDecisions(page)
    await page.getByTestId('review-copies-panel').waitFor()
    // The editor's panel is the way in from where the comments are listed.
    await page.getByTestId('review-work-through').click()
    await page.waitForSelector('[data-testid="interview-review-intro"]')
    assert.match(page.url(), /interview=1/)
    assert.match(page.url(), /review=1/)
    assert.equal(await page.locator('[data-testid="interview-run-until"]').count(), 0, 'it is not a run')
    assert.match(await page.textContent('[data-testid="interview-review-count"]'), /^9 review questions/)
    assert.match(await page.textContent('[data-testid="interview-start"]'), /Work through review comments/)
    assert.equal(await page.inputValue('[data-testid="interview-opening"]'), '', 'the same opening box as an interview\'s kickoff (#331), blank')

    // The rail lists the one thread Word resolved, collapsed, and can reopen it.
    const resolved = page.getByTestId('interview-review-resolved')
    assert.equal(await resolved.evaluate((el) => el.open), false)
    await resolved.locator('summary').click()
    assert.match(await resolved.textContent(), /Which card schemes\?/)

    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-round"]')
    assert.equal(posts.length, 0, 'the cards come before the AI is called')
    assert.match(await page.textContent('[data-testid="round-head"]'), /^Review comments · 9 comments · cards 1–4 of 9/)
    assert.match(await page.textContent('[data-testid="review-round-note"]'), /Reviewer 1, Reviewer 2/)

    // Ana's tracked change on an unchanged Field: the edit is recommended, and the architect sees the real name.
    const ana = page.locator('[data-testid="interview-card"][data-card-type="review"]').filter({ has: page.locator('[data-testid="review-card-changes"]'), hasText: 'Ana Reviewer' }).first()
    // It may be on a later page: page through until it is shown.
    for (let i = 0; i < 3 && (await ana.count()) === 0; i++) await page.click('[data-testid="round-next"]')
    await ana.waitFor()
    assert.deepEqual(await chosenOf(ana), ['Accept the edit'])
    assert.equal(await ana.locator('[data-testid="card-recommended"]').count(), 1)
    assert.match(await ana.locator('[data-testid="review-card-changes"]').textContent(), /must.*should/s)
    assert.equal(await ana.locator('[data-testid="review-unchanged"]').count(), 1)
    for (let i = 0; i < 3 && (await page.locator('[data-testid="round-back"]').isEnabled()); i++) await page.click('[data-testid="round-back"]')

    await answerRound(page)
    await page.getByTestId('review-ready').waitFor()
    assert.equal(posts.length, 0, 'Accept, Keep and Note need nothing written by the AI')
    assert.match(await page.textContent('[data-testid="review-ready"]'), /9 comments answered/)
    // Nothing is saved yet.
    assert.match(readFileSync(join(folder, 'modules', 'background.md'), 'utf8'), /It must support card schemes\./)

    await page.click('[data-testid="review-save"]')
    await page.getByTestId('review-saved').waitFor()
    assert.match(await page.textContent('[data-testid="review-saved-summary"]'), /9 comments logged, 2 Fields changed/)
    assert.match(await page.textContent('[data-testid="review-rerender-nudge"]'), /Render again.*a Save never renders the Word documents/s, 'the nudge to render again shows after the Save')

    // On disk: the edit, the Module still draft, the log with the real names and the full comments, and the manifest's count.
    const module = readFileSync(join(folder, 'modules', 'background.md'), 'utf8')
    assert.match(module, /It should support card schemes\./)
    assert.match(module, /Reduce cost per transaction\.\n\nImprove settlement speed\./, 'a paragraph Ben inserted goes where he put it')
    assert.match(module, /status: draft/)
    const log = readYaml(join(folder, 'interview', 'shape.yaml'))
    const answered = log.entries.filter((e) => e.kind === 'review-answered')
    assert.equal(answered.length, 9)
    const edit = answered.find((e) => e.outcome === 'accept')
    assert.deepEqual(edit.changes.map((c) => [c.kind, c.author, c.text]), [['deletion', 'Ana Reviewer', 'must'], ['insertion', 'Ana Reviewer', 'should']])
    assert.equal(edit.review, entry.id)
    const team = answered.find((e) => e.threads?.[0]?.text === 'Add the team')
    assert.equal(team.threads[0].author, 'Ben Commenter')
    assert.deepEqual(team.changedSinceRender, { 'background.success-criteria': false })
    await page.waitForFunction(async (slug) => (await (await fetch(`/api/instance/reviews?slug=${slug}`)).json()).reviews[0].commentsAnswered > 0, SLUG)
    const manifest = readYaml(join(folder, 'reviews', 'manifest.yaml'))
    assert.equal(manifest[0].commentsAnswered, 9)

    // Answered threads are not asked again; the resolved one can be reopened.
    await page.goto(`${base}/instance/${SLUG}?interview=1&review=1`)
    await page.waitForSelector('[data-testid="interview-review-none"]')
    assert.equal(await page.isDisabled('[data-testid="interview-start"]'), true)
    await page.getByTestId('interview-review-resolved').locator('summary').click()
    await page.click('[data-testid="interview-review-reopen"]')
    await page.waitForSelector('[data-testid="interview-review-count"]')
    assert.match(await page.textContent('[data-testid="interview-review-count"]'), /^1 review question/)
  })
})

test('server workspace: a revision goes to the AI as Reviewer N with no real name, and meets the keep / use / merge card', async () => {
  await withReviewServer(async ({ page, base, posts, folder }) => {
    await page.goto(`${base}/instance/${SLUG}?interview=1&review=1`)
    await page.waitForSelector('[data-testid="interview-review-intro"]')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-round"]')
    // Revise "Add the team" with the architect's own words (which name the reviewer: that must not reach the AI either).
    for (let i = 0; i < 3 && (await cardWith(page, 'Add the team').count()) === 0; i++) await page.click('[data-testid="round-next"]')
    const team = cardWith(page, 'Add the team')
    await choose(team, 'Revise')
    await team.locator('[data-testid="review-reason"]').fill('Ben is right, and add Risk.')
    while (await page.locator('[data-testid="round-back"]').isEnabled()) await page.click('[data-testid="round-back"]')
    await answerRound(page, new Map([['Add the team', 'Revise']]))
    // The AI redrafted a Field that holds saved content, so the architect is asked: keep, use the AI's version, or merge.
    await page.locator('[data-testid="interview-card"][data-card-type="change"]').waitFor()
    assert.ok(posts.length >= 1)
    const sent = posts.map((p) => p.raw).join('\n')
    assert.doesNotMatch(sent, NAMES, 'no commenter’s real name reaches the AI')
    assert.match(firstUserText(posts[0].body), /Reviewer 2 commented/)
    assert.match(firstUserText(posts[0].body), /Add the team/)
    await choose(page.locator('[data-testid="interview-card"][data-card-type="change"]'), "Use the AI's version")
    await page.click('[data-testid="round-submit"]')
    await page.getByTestId('review-ready').waitFor()
    await page.click('[data-testid="review-save"]')
    await page.getByTestId('review-saved').waitFor()
    assert.match(readFileSync(join(folder, 'modules', 'background.md'), 'utf8'), /Payments Engineering and Risk\./)
    const log = readYaml(join(folder, 'interview', 'shape.yaml'))
    const revise = log.entries.find((e) => e.kind === 'review-answered' && e.outcome === 'revise')
    assert.equal(revise.words, 'Ben is right, and add Risk.', 'the repo keeps the architect’s words as they typed them')
    assert.equal(revise.threads[0].author, 'Ben Commenter')
  })
})

test('server workspace: review questions join a running interview’s next round, or come with it from the start', async () => {
  await withReviewServer(async ({ page, base, posts }) => {
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-start"]')
    assert.match(await page.textContent('[data-testid="interview-kickoff-review-note"]'), /9 review questions/)
    await page.click('[data-testid="interview-start"]')
    // The stand-in asks nothing, so the interview is waiting for the architect.
    await page.waitForFunction(() => document.querySelector('[data-testid="interview-status"]') === null && document.querySelector('[data-testid="interview-chat"]') && !document.querySelector('[data-testid="interview-chat"]').disabled)
    assert.equal(await page.locator('[data-testid="interview-round"]').count(), 0)
    // The box was left off, so the rail's button adds the questions to the running session: a round of their own.
    await page.click('[data-testid="interview-review-join"]')
    await page.waitForSelector('[data-testid="interview-round"]')
    assert.match(await page.textContent('[data-testid="round-head"]'), /9 questions/)
    const before = posts.length
    await answerRound(page)
    // Only Keep, Note and Accept were chosen: the AI is not called again, and the interview is where it was.
    await page.waitForFunction(() => document.querySelector('[data-testid="interview-round"]') === null)
    assert.equal(posts.length, before)
    assert.doesNotMatch(posts.map((p) => p.raw).join('\n'), NAMES)
    assert.equal(await page.locator('[data-testid="interview-card"][data-card-type="review"]').count(), 0)
  })

  // Ticking the box at the kickoff puts them in the first round the interview asks.
  await withReviewServer(async ({ page, base, posts }) => {
    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-start"]')
    await page.check('[data-testid="interview-review-with-interview"]')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-round"]')
    assert.match(await page.textContent('[data-testid="round-head"]'), /9 questions/)
    assert.ok(posts.length >= 1, 'the interview itself began')
    assert.match(await page.textContent('[data-testid="interview-thread"]'), /9 review comments are in this round/)
  })
})

test('server workspace: review comments are brought in from the Interview page itself, and then worked through', async () => {
  await withReviewServer(
    async ({ page, base }) => {
      await page.goto(`${base}/instance/${SLUG}?interview=1`)
      await page.waitForSelector('[data-testid="interview-review-none"]')
      assert.equal(await page.locator('[data-testid="interview-review-start"]').count(), 0, 'nothing to work through yet')
      await page.click('[data-testid="interview-bring-in-review"]')
      const dialog = page.locator('.modal[aria-label="Bring in review comments"]')
      await dialog.waitFor({ state: 'visible' })
      await dialog.getByTestId('review-file-input').setInputFiles({
        name: 'HLD - Ana and Ben.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        buffer: reviewedCopy({ kind: 'word', properties: { ...RENDER_PROPERTIES, instance: SLUG } }),
      })
      await dialog.locator('[data-testid="review-import-list"] li[data-ok="true"]').waitFor()
      await dialog.getByTestId('review-bring-in').click()
      await dialog.getByTestId('review-import-done').waitFor()
      await dialog.getByRole('button', { name: 'Close' }).click()

      // The rail now lists the copy, and the button is there.
      await page.waitForSelector('[data-testid="interview-review-start"]')
      assert.match(await page.textContent('[data-testid="interview-review-copies"]'), /HLD - Ana and Ben\.docx: 0 of 9 answered/)
      assert.match(await page.textContent('[data-testid="interview-review-count"]'), /^9 review questions/)
      await page.click('[data-testid="interview-review-start"]')
      await page.waitForSelector('[data-testid="interview-review-intro"]')
      assert.match(page.url(), /review=1/)
      assert.match(await page.textContent('[data-testid="interview-review-count"]'), /9 review questions/)
    },
    { copy: false }
  )
})

// #304 (ADR-0066): the Review response list. Built from the decisions log on demand and downloaded as Word; nothing is written to the Reviewed copy or committed.
const wordText = async (path) => (await readPackageTexts(new Uint8Array(readFileSync(path)), (name) => name === 'word/document.xml')).get('word/document.xml')

test('server workspace: after a review round the Review response list downloads as Word, from the Interview page and from the editor, and nothing is written for it', async () => {
  await withReviewServer(async ({ page, base, folder, entry }) => {
    const reviewsBefore = readdirSync(join(folder, 'reviews')).sort()
    const copyBefore = readFileSync(join(folder, 'reviews', `${entry.id}.docx`))
    await page.goto(`${base}/instance/${SLUG}?interview=1&review=1`)
    await page.waitForSelector('[data-testid="interview-review-intro"]')
    assert.equal(await page.locator('[data-testid="interview-response-download"]').count(), 0, 'with no comment answered there is no list to download')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-round"]')
    await answerRound(page, new Map([['Add the team', 'Keep as is']]))
    await page.getByTestId('review-ready').waitFor()
    await page.click('[data-testid="review-save"]')
    await page.getByTestId('review-saved').waitFor()
    assert.match(await page.textContent('[data-testid="review-rerender-nudge"]'), /Render again/)
    assert.match(await page.textContent('[data-testid="review-rerender-nudge"]'), /hld/i)

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="review-response-download"]')])
    assert.match(download.suggestedFilename(), /Review response list\.docx$/)
    const path = await download.path()
    const document = await wordText(path)
    assert.match(document, /9 comments answered/)
    assert.match(document, /Add the team/)
    assert.match(document, /Ben Commenter/)
    assert.match(document, /Ana Reviewer/)
    assert.match(document, /Kept as it was/)
    assert.match(document, /Edit accepted/)
    assert.equal((document.match(/<w:tr>/g) ?? []).length, 10, 'a header row and a row for each of the nine answered threads')
    // The rail offers the same download once there are answers.
    assert.match(await page.textContent('[data-testid="interview-response-download"]'), /\(9\)/)

    // Nothing was written for the list: the Reviewed copy is as it was, and no other file appeared under reviews/.
    assert.deepEqual(readdirSync(join(folder, 'reviews')).sort(), reviewsBefore)
    assert.ok(readFileSync(join(folder, 'reviews', `${entry.id}.docx`)).equals(copyBefore), 'the Reviewed copy is never changed')
    assert.deepEqual(readdirSync(folder).filter((f) => /response/i.test(f)), [])

    // The editor's Review comments panel offers it too, once the manifest says comments are answered.
    await page.goto(`${base}/instance/${SLUG}`)
    await showSourcesAndDecisions(page)
    await page.getByTestId('review-copies-panel').waitFor()
    await page.getByTestId('review-response').waitFor()
    const [again] = await Promise.all([page.waitForEvent('download'), page.click('[data-testid="review-response-download"]')])
    assert.equal(again.suggestedFilename(), download.suggestedFilename())
    assert.match(await wordText(await again.path()), /Add the team/)
  })
})

test('server workspace: the editor offers no Review response list until a comment has been answered', async () => {
  await withReviewServer(async ({ page, base }) => {
    await page.goto(`${base}/instance/${SLUG}`)
    await showSourcesAndDecisions(page)
    await page.getByTestId('review-copies-panel').waitFor()
    assert.equal(await page.locator('[data-testid="review-response"]').count(), 0)
  })
})

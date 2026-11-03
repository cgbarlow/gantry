import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse as parseYAML } from 'yaml'
import { stageBranchName } from '../lib/stageBranch.js'
import { PROVIDERS, ROOT, SLUG, draftStage, json, open, pullRequestOf, row, states, waitState, withRemoteTrio } from './helpers/remoteTrio.js'
import { revisionScript } from './helpers/interviewStandIn.js'

// #299 (parent #238, decided in #247): the AI revises a Stage the Owner sent back. A real gantry server and relay, a fake Provider (the Owner
// comments and votes directly on it, as in real life), a real Chromium page and a stand-in for Anthropic, on the three-Stage Definition.

const scopeBranch = stageBranchName(SLUG, 's1')
const shapeBranch = stageBranchName(SLUG, 's2')
const choose = (page, card, label) => page.locator(`[data-testid="interview-card"][data-card-id="${card}"] [data-testid="card-option"][data-option="${label}"] input`).check()
const options = (page, card) => page.locator(`[data-testid="interview-card"][data-card-id="${card}"] [data-testid="card-option"]`).evaluateAll((els) => els.map((el) => el.dataset.option))

// Scope is saved and awaiting approval; Shape was drafted ahead of it, from Scope's Field, and (unless `saveShape` is false) queued. Returns Scope's Pull Request.
async function scopeAwaitingShapeQueued(page, base, api, { saveShape = true } = {}) {
  await open(page, base)
  await draftStage(page, 's2')
  await page.click('[data-testid="interview-save-approval"]')
  await waitState(page, 's1', 'awaiting-approval')
  const pr = await pullRequestOf(api, 's1')
  await page.waitForSelector('[data-testid="interview-stage-end"]')
  if (!saveShape) return pr
  await page.click('[data-testid="interview-save-approval"]')
  await page.waitForSelector('[data-testid="interview-approval-queued"]')
  return pr
}

for (const spec of PROVIDERS) {
  test(`${spec.name}: changes requested sends the session back to Scope; every comment becomes a card, the revision updates the Pull Request without writing to it, and Shape's stale Field gets a keep / redraft round`, async () => {
    await withRemoteTrio(
      spec,
      async ({ page, base, ctx, client, api }) => {
        const pr = await scopeAwaitingShapeQueued(page, base, api)
        assert.deepEqual(await states(page), ['s1:awaiting-approval', 's2:approval-queued*', 's3:beyond'])

        // The Owner comments (one thread resolved where the Provider has threads) and requests changes, on the Provider.
        assert.ok((await spec.comment(ctx, pr, { body: 'Please name the owner in the notes.' })).status < 300)
        assert.ok((await spec.comment(ctx, pr, { body: 'The second paragraph has a typo.', resolved: true })).status < 300)
        assert.ok((await spec.requestChanges(ctx, pr)).status < 300)
        const written = await spec.written(ctx, pr)

        // Clicking Scope's row runs Check status. The session is on Shape (drafted ahead): drafting ahead pauses on one card.
        await row(page, 's1').locator('.rp-title').click()
        await page.waitForSelector('[data-testid="interview-sent-back"]')
        assert.equal(await page.getAttribute('[data-testid="interview-sent-back"]', 'data-kind'), 'changes-requested')
        assert.match(await page.textContent('[data-testid="interview-sent-back"]'), /Scope was sent back/)
        assert.match(await page.textContent('[data-testid="interview-sent-back"]'), /what the AI drafted ahead is kept/)
        assert.equal(await page.locator('[data-testid="interview-revise"]').textContent().then((t) => t.replace(/\s+/g, ' ').trim()), 'Revise Scope with the AIRECOMMENDED')
        assert.equal(await page.locator('[data-testid="interview-stop-session"]').textContent(), 'Stop the session here')
        assert.deepEqual(await states(page), ['s1:awaiting-approval', 's2:approval-queued*', 's3:beyond'])

        // Revise: the page goes back to Scope. Gantry has read every comment on the Pull Request; nothing is asked of the AI yet.
        await page.click('[data-testid="interview-revise"]')
        await page.waitForSelector('[data-testid="interview-revise-intro"]')
        await page.waitForSelector('[data-testid="interview-revise-count"]')
        assert.match(await page.textContent('[data-testid="interview-revise-count"]'), new RegExp(`2 comments on Pull Request #${pr}`))
        assert.equal(await page.locator('[data-testid="interview-awaiting-approval"]').count(), 0)
        await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
        await page.click('[data-testid="interview-start"]')
        await page.waitForSelector('[data-testid="interview-round"]')
        await waitState(page, 's1', 'revising')

        // The comments are listed in the conversation, and a card asks about each one, resolved or not.
        const thread = await page.locator('[data-testid="interview-thread"]').textContent()
        assert.match(thread, /Scope was sent back\. 2 comments on Pull Request #\d+, resolved ones included/)
        assert.match(thread, /Please name the owner in the notes\./)
        assert.match(thread, /The second paragraph has a typo\./)
        const cards = page.locator('[data-testid="interview-card"][data-card-type="comment"]')
        assert.equal(await cards.count(), 2)
        const first = cards.filter({ hasText: 'name the owner' })
        const second = cards.filter({ hasText: 'second paragraph' })
        assert.deepEqual(await first.locator('[data-testid="card-option"]').evaluateAll((els) => els.map((el) => el.dataset.option)), ['Change the content', 'No change needed', 'Log an open question'])
        assert.ok(await first.locator('[data-testid="comment-link"]').count() === 1, 'the card links to the comment on the Provider')
        const resolvedRecommendation = await second.locator('[data-testid="card-option"][data-chosen="true"]').evaluateAll((els) => els.map((el) => el.dataset.option))
        assert.deepEqual(resolvedRecommendation, [spec.provider === 'azure-devops' ? 'No change needed' : 'Change the content'], 'a resolved thread is asked about too, and recommends leaving it')
        await second.locator('[data-testid="card-option"][data-option="No change needed"] input').check()
        await first.locator('[data-testid="card-option"][data-option="Change the content"] input').check()
        await page.click('[data-testid="round-submit"]')

        // The AI redrafts only what was chosen. Scope's Field holds saved content, so it meets a keep / use / merge card.
        await page.waitForSelector('[data-testid="interview-card"][data-card-type="change"]')
        assert.deepEqual(await options(page, 'change:m1.body'), ['Keep', "Use the AI's version", 'Merge'])
        await choose(page, 'change:m1.body', "Use the AI's version")
        await page.click('[data-testid="round-submit"]')
        await page.waitForSelector('[data-testid="revise-ready"]')
        assert.deepEqual(await states(page), ['s1:revising', 's2:approval-queued*', 's3:beyond'])
        assert.equal(await client.getFileContent(`${ROOT}/modules/m1.md`, { branch: scopeBranch }).then((t) => t.includes('Revised notes')), false, 'nothing is saved until the revision is')

        // Save the revision: one Stage Save on Scope's branch, which updates the open Pull Request. The row goes back to Awaiting approval.
        await page.click('[data-testid="revise-save"]')
        await page.waitForSelector('[data-testid="revise-saved"]')
        assert.deepEqual(await states(page), ['s1:awaiting-approval', 's2:approval-queued*', 's3:beyond'])
        assert.match(await client.getFileContent(`${ROOT}/modules/m1.md`, { branch: scopeBranch }), /Revised notes for s1: the owner is named/)
        assert.equal(await client.fileExists(`${ROOT}/modules/m1.md`, 'main'), false, 'main is untouched')
        assert.equal((await (await api('/api/instance')).json()).pullRequests.s1, pr, 'the same Pull Request is still open')
        assert.equal(await page.locator('[data-testid="revise-pr-link"]').count(), 1, 'the open Pull Request is linked, and it is not closed')
        assert.equal(await page.locator('[data-testid="revise-pr-closed"]').count(), 0)
        assert.match(await page.textContent('[data-testid="revise-tell-owner"]'), /Nothing was written to the Pull Request: no comments, no replies, no resolved threads\. Tell the Owner it is ready for another look/)
        assert.equal(await spec.written(ctx, pr), written, 'the AI wrote nothing to the Pull Request')

        // The decisions log keeps a "PR comment answered" entry for each comment: author, link, excerpt and the entries that answered it.
        const log = parseYAML(await client.getFileContent(`${ROOT}/interview/s1.yaml`, { branch: scopeBranch }))
        const answered = log.entries.filter((e) => e.kind === 'pr-comment-answered')
        assert.equal(answered.length, 2)
        const byExcerpt = (text) => answered.find((e) => e.excerpt.includes(text))
        assert.deepEqual([byExcerpt('name the owner').author, byExcerpt('name the owner').outcome, byExcerpt('typo').outcome], ['The Owner', 'change', 'no-change'])
        assert.equal(byExcerpt('name the owner').pullRequest, pr)
        assert.ok(byExcerpt('name the owner').url, 'it keeps a link to the comment')
        for (const entry of answered) {
          assert.equal(entry.entries.length, 1)
          const answer = log.entries.find((e) => e.id === entry.entries[0])
          assert.equal(answer.kind, 'answer', 'the entries that answered the comment are in the log')
        }
        assert.equal(log.status.at(-1).state, 'awaiting-approval')

        // Shape was drafted from Scope's Field, which the revision changed: Gantry finds it by fingerprint and asks, before the run carries on.
        assert.match(await page.textContent('[data-testid="revise-stale-note"]'), /1 Field on Shape was drafted from content this revision changed: Shape notes · Body/)
        await page.click('[data-testid="revise-review-later"]')
        await page.waitForSelector('[data-testid="interview-update-count"]')
        assert.match(await page.textContent('[data-testid="interview-update-count"]'), /1 Field on Shape is Out of date/)
        await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
        await page.click('[data-testid="interview-start"]')
        await page.waitForSelector('[data-testid="interview-card"][data-card-type="update"]')
        assert.deepEqual(await options(page, 'update:m2.body'), ['Keep', 'Redraft'])
        assert.match(await page.textContent('[data-testid="card-question"]'), /Shape notes · Body: Scope notes · Body has changed since this was drafted/)
        await choose(page, 'update:m2.body', 'Redraft')
        await page.click('[data-testid="round-submit"]')
        await page.waitForSelector('[data-testid="interview-card"][data-card-type="change"]')
        await choose(page, 'change:m2.body', "Use the AI's version")
        await page.click('[data-testid="round-submit"]')
        await page.waitForSelector('[data-testid="update-ready"]')
        await page.click('[data-testid="update-save"]')
        await page.waitForSelector('[data-testid="update-saved"]')

        // Shape's redraft is on Shape's branch, and Shape is still queued for approval: bringing it up to date did not make it look finished.
        assert.match(await client.getFileContent(`${ROOT}/modules/m2.md`, { branch: shapeBranch }), /Redrafted notes for s2/)
        const shapeLog = parseYAML(await client.getFileContent(`${ROOT}/interview/s2.yaml`, { branch: shapeBranch }))
        assert.equal(shapeLog.status.at(-1).state, 'approval-queued')
        const kept = shapeLog.entries.find((e) => e.kind === 'source-update')
        assert.deepEqual([kept.inputField, kept.outcome, kept.fields], ['m1.body', 'redraft', ['m2.body']])
        assert.equal(await spec.written(ctx, pr), written, 'still nothing written to the Pull Request')
      },
      { script: revisionScript() }
    )
  })

  test(`${spec.name}: a rejected Stage pauses drafting ahead on one card, and "Stop the session here" keeps what was drafted ahead`, async () => {
    await withRemoteTrio(
      spec,
      async ({ page, base, ctx, client, api }) => {
        // Shape is drafted ahead and not saved yet: its drafts are only in the preview. The Owner rejects Scope.
        const pr = await scopeAwaitingShapeQueued(page, base, api, { saveShape: false })
        assert.equal(await client.branchExists(shapeBranch), false, 'nothing of Shape is saved')
        assert.ok((await spec.reject(ctx, pr)).status < 300)
        await row(page, 's1').locator('.rp-title').click()
        await page.waitForSelector('[data-testid="interview-sent-back"]')
        assert.equal(await page.getAttribute('[data-testid="interview-sent-back"]', 'data-kind'), 'rejected')
        assert.match(await page.textContent('[data-testid="interview-sent-back"] .qchip'), /Rejected/)
        assert.match(await page.textContent('[data-testid="interview-sent-back"]'), /Scope was rejected/)
        assert.deepEqual(await page.locator('[data-testid="interview-sent-back"] button').evaluateAll((els) => els.map((el) => el.textContent.replace(/\s+/g, ' ').trim())), ['Revise Scope with the AIRECOMMENDED', 'Stop the session here', 'Check status again'])
        await page.click('[data-testid="interview-stop-session"]')
        await page.waitForSelector('[data-testid="sent-back-stopped"]')
        assert.equal(await page.locator('[data-testid="interview-stop-session"]').count(), 0)
        // Drafted-ahead work is kept: stopping saved it as a head start on Shape's branch.
        assert.match(await client.getFileContent(`${ROOT}/modules/m2.md`, { branch: shapeBranch }), /Notes for s2/)
        const keptLog = parseYAML(await client.getFileContent(`${ROOT}/interview/s2.yaml`, { branch: shapeBranch }))
        assert.equal(keptLog.status.at(-1).state, 'head-start')
        assert.match(await page.textContent('[data-testid="sent-back-stopped"]'), /The session stopped here/)
      },
      { script: revisionScript() }
    )
  })

  test(`${spec.name}: the AI's offer to re-open a signed-off Stage becomes a card only when Gantry would allow it; otherwise it is an open question naming the blocker`, async () => {
    // Scope is approved and merged by the Owner; the Instance moves on to Shape, which the architect then interviews.
    const scopeMerged = async ({ page, base, ctx, api }) => {
      await open(page, base)
      await draftStage(page, null)
      await page.click('[data-testid="interview-save-approval"]')
      await waitState(page, 's1', 'awaiting-approval')
      const pr = await pullRequestOf(api, 's1')
      assert.ok((await spec.approve(ctx, pr)).status < 300)
      return pr
    }

    // Allowed: Shape is current and has no branch of its own yet, so Scope can be re-opened (ADR-0026).
    await withRemoteTrio(
      spec,
      async (env) => {
        const { page, api } = env
        await scopeMerged(env)
        await row(page, 's1').locator('.rp-title').click()
        await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
        assert.equal((await (await api('/api/instance')).json()).currentStageId, 's2')
        assert.ok((await spec.deleteBranch(env.ctx, env.client, scopeBranch)).status < 300, 'the Provider deleted the merged branch')
        await page.click('[data-testid="interview-start"]')
        // The AI drafts Shape and also offers to re-open Scope, because a new Source document contradicts the approved scope.
        await page.waitForSelector('[data-testid="interview-card"][data-card-type="reopen"]')
        assert.deepEqual(await page.locator('[data-testid="interview-card"][data-card-type="reopen"] [data-testid="card-option"]').evaluateAll((els) => els.map((el) => el.dataset.option)), ['Re-open Scope', 'Not now'])
        assert.match(await page.textContent('[data-testid="interview-card"][data-card-type="reopen"] [data-testid="card-question"]'), /contradicts the approved scope/)
        await page.click('[data-testid="round-submit"]')
        // Re-opened: Scope is the current Stage again, joins the run, and its page starts by itself. Its log carries on in the same file.
        await waitState(page, 's1', 'drafting')
        assert.equal((await (await api('/api/instance')).json()).currentStageId, 's1', 'Scope is open again')
        assert.deepEqual(await states(page), ['s1:drafting', 's2:waiting*', 's3:beyond'], 'the re-opened Stage joined the run')
        assert.equal(await page.locator('[data-testid="interview-session-warning"]').count(), 0, 'the session that signed it off is finished with it')
      },
      { script: revisionScript({ offerReopen: 's1' }) }
    )

    // Not allowed: Shape already has a branch, so Scope cannot be re-opened. An open question names the blocker; no card is shown.
    await withRemoteTrio(
      spec,
      async (env) => {
        const { page, api } = env
        await scopeMerged(env)
        const started = await api('/api/instance/modules?stage=s2', json('PUT', { modules: { m2: { status: 'draft', owner: '', fields: { body: 'Shape was started elsewhere.' } } } }))
        assert.equal(started.status, 200, 'Shape has a branch')
        await row(page, 's1').locator('.rp-title').click()
        await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
        await page.click('[data-testid="interview-start"]')
        await page.waitForSelector('[data-testid="interview-thread"] .msg.sys:has-text("cannot be re-opened right now")')
        assert.equal(await page.locator('[data-testid="interview-card"][data-card-type="reopen"]').count(), 0, 'no card is offered')
        assert.match(await page.textContent('[data-testid="interview-thread"]'), /Scope cannot be re-opened right now: Shape is already in progress, and a Stage cannot be re-opened while a later one is \(ADR-0026\)\. Logged as an open question\./)
        assert.equal((await (await api('/api/instance')).json()).currentStageId, 's2', 'nothing was re-opened')
        assert.match(await page.textContent('[data-testid="interview-rail-open-questions"], [data-testid="interview-thread"]'), /re-opened/)
      },
      { script: revisionScript({ offerReopen: 's1' }) }
    )
  })
}

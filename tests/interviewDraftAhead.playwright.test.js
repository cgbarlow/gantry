import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse as parseYAML } from 'yaml'
import { stageBranchName } from '../lib/stageBranch.js'
import { PROVIDERS, ROOT, SLUG, draftStage, json, open, states, waitState, withRemoteTrio } from './helpers/remoteTrio.js'
import { sharedScript } from './helpers/interviewStandIn.js'

// #296 (parent #238, docs/adr/0063): the AI drafts ahead while an earlier Stage awaits approval. A real gantry server and relay, a fake
// Provider, a real Chromium page and a stand-in for Anthropic, on the three-Stage Definition where Scope and Shape also share a Module
// (`mx`): Shape, drafted ahead of Scope's approval, gets a head start in its own Module only, and extends the shared one once Scope merges.

const shared = { shared: true, script: sharedScript }
const shapeBranch = stageBranchName(SLUG, 's2')

for (const spec of PROVIDERS) {
  test(`${spec.name}: with Scope's Pull Request open the AI drafts Shape's own Module, Gantry refuses the shared one, the Waiting card saves the head start, and Check approval now carries on into the shared Fields once Scope merges`, async () => {
    await withRemoteTrio(
      spec,
      async ({ page, base, ctx, posts, checks, client, api }) => {
        await open(page, base)
        await draftStage(page, 's2')
        await page.click('[data-testid="interview-save-approval"]')

        // The session moves on to Shape by itself and drafts what it can: Shape's own Module. The shared one is held.
        await page.waitForSelector('[data-testid="interview-waiting"]')
        assert.deepEqual(await states(page), ['s1:awaiting-approval', 's2:waiting-for-approval*', 's3:beyond'])
        assert.equal((await (await api('/api/instance')).json()).currentStageId, 's1', 'the Instance stays on Scope')
        const shapeBriefs = posts.filter((p) => JSON.stringify(p.body.system ?? '').includes('PURPOSE-s2'))
        assert.ok(shapeBriefs.length > 0)
        assert.match(JSON.stringify(shapeBriefs[0].body.system), /Head start only: this Stage is being drafted ahead, while Scope awaits approval/)
        assert.match(JSON.stringify(shapeBriefs[0].body.system), /held until Scope is approved/)
        assert.equal(await page.locator('[data-testid="interview-field"][data-field-key="m2.body"]').count(), 1)
        assert.equal(await page.locator('[data-testid="interview-field"][data-field-key="mx.more"]').count(), 0, 'a held Module is not drafted')
        assert.match(await page.textContent('[data-testid="interview-waiting-held"]'), /Held until Scope is approved and merged: Shared notes/)
        assert.equal(await page.locator('[data-testid="interview-stage-end"]').count(), 0, 'Shape is not ready: its Gate needs the shared Field')
        assert.deepEqual(checks, [], 'nothing polls')

        // Gantry itself refuses a write to the shared Module on Shape, whoever asks; Shape's own Module is fine.
        const refused = await api('/api/instance/modules?stage=s2', json('PUT', { modules: { mx: { status: 'draft', owner: '', fields: { more: 'Sneaky.' } } } }))
        assert.equal(refused.status, 400)
        const refusal = await refused.json()
        assert.equal(refusal.code, 'shared-module-pending')
        assert.match(refusal.error, /"Shared notes" \(mx\) with Stage "Scope" \(s1\)/)
        assert.equal(await client.fileExists(`${ROOT}/modules/mx.md`, shapeBranch), false)

        // Check approval now saves the head start (one commit on Shape's branch, its log in it) and then asks the Provider once.
        await page.click('[data-testid="interview-check-approval-now"]')
        await page.waitForSelector('[data-testid="interview-head-start-saved"]')
        await page.waitForSelector('[data-testid="interview-approval-message"]')
        assert.match(await page.textContent('[data-testid="interview-approval-message"]'), /Still pending: the Owner has not reviewed Pull Request #\d+ yet/)
        assert.equal(checks.length, 1)
        assert.match(await client.getFileContent(`${ROOT}/modules/m2.md`, { branch: shapeBranch }), /Notes for s2/)
        const headLog = parseYAML(await client.getFileContent(`${ROOT}/interview/s2.yaml`, { branch: shapeBranch }))
        assert.deepEqual([headLog.status[0].state, headLog.status[0].target], ['head-start', 's2'])
        assert.deepEqual(headLog.status[0].stages, { s1: 'awaiting-approval', s2: 'head-start' })
        assert.equal(headLog.status[0].saves.length, 1)
        assert.equal(await client.fileExists(`${ROOT}/interview/s2.yaml`, 'main'), false, 'main is untouched')
        assert.deepEqual(await states(page), ['s1:awaiting-approval', 's2:waiting-for-approval*', 's3:beyond'])

        // The Owner approves Scope. Check approval now (nothing left to save) finds the merge, tells the AI the Module is open, and the AI extends it.
        const firstPr = (await (await api('/api/instance')).json()).pullRequests.s1
        assert.ok((await spec.approve(ctx, firstPr)).status < 300)
        await page.click('[data-testid="interview-check-approval-now"]')
        await page.waitForSelector('[data-testid="interview-stage-end"]')
        await waitState(page, 's1', 'done')
        assert.deepEqual(await states(page), ['s1:done', 's2:awaiting-confirmation*', 's3:beyond'])
        assert.equal(checks.length, 2)
        assert.equal(await page.locator('[data-testid="interview-field"][data-field-key="mx.more"]').count(), 1, 'the shared Module\'s Field was drafted once it opened')
        assert.equal((await (await api('/api/instance')).json()).currentStageId, 's2')
        assert.match(JSON.stringify(posts[posts.length - 1].body.messages), /no longer held/)

        // Shape's full Save is its second AI Save, and the log records both.
        await page.click('[data-testid="interview-save-approval"]')
        await page.waitForSelector('[data-testid="interview-awaiting-approval"]')
        const log = parseYAML(await client.getFileContent(`${ROOT}/interview/s2.yaml`, { branch: shapeBranch }))
        assert.equal(log.status.length, 1, 'one session')
        assert.equal(log.status[0].saves.length, 2, 'two AI Saves on the Stage')
        assert.equal(log.status[0].lastAiSave, log.status[0].saves[1])
        assert.match(await client.getFileContent(`${ROOT}/modules/mx.md`, { branch: shapeBranch }), /Shape extends the shared notes/)
        assert.equal(checks.length, 2, 'asking for approval is not a Check status')
      },
      shared
    )
  })

  test(`${spec.name}: Stop here on the Waiting card saves the head start and stops the session, and the head start shows as waiting on a later visit`, async () => {
    await withRemoteTrio(
      spec,
      async ({ page, base, checks, client, api }) => {
        await open(page, base)
        await draftStage(page, 's2')
        await page.click('[data-testid="interview-save-approval"]')
        await page.waitForSelector('[data-testid="interview-waiting"]')
        assert.match(await page.textContent('[data-testid="interview-waiting-note"]'), /saves the head start as one commit on Shape's branch/)

        await page.click('[data-testid="interview-stop-here"]')
        await page.waitForSelector('[data-testid="interview-waiting-stopped"]')
        assert.equal(await page.locator('[data-testid="interview-check-approval-now"]').count(), 0, 'the session has stopped')
        assert.match(await page.textContent('[data-testid="interview-head-start-saved"]'), /1 Field/)
        assert.deepEqual(checks, [], 'Stop here asks the Provider nothing')
        assert.deepEqual(await states(page), ['s1:awaiting-approval', 's2:waiting-for-approval*', 's3:beyond'])
        const log = parseYAML(await client.getFileContent(`${ROOT}/interview/s2.yaml`, { branch: shapeBranch }))
        assert.equal(log.status[0].state, 'head-start')
        assert.match(await client.getFileContent(`${ROOT}/modules/m2.md`, { branch: shapeBranch }), /Notes for s2/)

        // A later visit: Scope awaits approval and Shape is shown as holding a head start, from its log; Gantry still holds the shared Module.
        await open(page, base)
        await page.waitForSelector('[data-testid="interview-awaiting-approval"]')
        await waitState(page, 's2', 'waiting-for-approval')
        assert.deepEqual(await states(page), ['s1:awaiting-approval', 's2:waiting-for-approval*', 's3:beyond'])
        const refused = await api('/api/instance/modules/mx?stage=s2', json('PUT', { status: 'draft', owner: '', fields: { more: 'Sneaky.' } }))
        assert.equal(refused.status, 400)
      },
      shared
    )
  })
}

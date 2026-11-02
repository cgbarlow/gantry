import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { stageBranchName } from '../lib/stageBranch.js'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { GITHUB_OWNER, GITHUB_REPOSITORY, ORGANIZATION, PROJECT, REPOSITORY, basicAuthHeader, withRunningServerForProvider } from './helpers/lifecycle.js'
import { seedProviders, trioScript, withFakeAnthropic } from './helpers/interviewStandIn.js'
import { writeTrio } from './helpers/trioDefinition.js'

// #295 (parent #238, docs/adr/0063): the AI interview on Azure DevOps and GitHub workspaces requests approval in Stage order. A real
// gantry server and relay, a real (fake, in-process) Provider, a real Chromium page and a stand-in for Anthropic that drafts the one Field
// each Stage of a small three-Stage Definition needs. The Owner's approval is cast directly at the Provider, as it is in real life.

const SLUG = 'remote-trio'
const ROOT = `gantry-workspace/${SLUG}`
const INSTANCE_YAML = `definition: trio\nslug: ${SLUG}\nstage: s1\ndefinitionVersion: 1\n`
const json = (method, body, headers = {}) => ({ method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

const PROVIDERS = [
  {
    name: 'Azure DevOps',
    provider: 'azure-devops',
    kind: 'azureDevOps',
    author: 'Fake Pusher',
    prPath: /\/pullrequest\/\d+$/,
    location: (ctx) => ({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: ctx.providerBaseUrl }),
    client: (ctx) => createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
    approve: (ctx, pullRequestId) =>
      fetch(`${ctx.providerBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}/reviewers/owner-1`, {
        method: 'PUT',
        headers: { Authorization: basicAuthHeader(ctx.pat), 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'The Owner', vote: 10 }),
      }),
  },
  {
    name: 'GitHub',
    provider: 'github',
    kind: 'github',
    author: 'Fake Author',
    prPath: /\/pull\/\d+$/,
    location: (ctx) => ({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: ctx.providerBaseUrl }),
    client: (ctx) => createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
    approve: (ctx, pullRequestId) =>
      fetch(`${ctx.providerBaseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${pullRequestId}/reviews`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.pat}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'APPROVE' }),
      }),
  },
]

// A remote workspace of the trio, a stand-in AI, and one page in a Chromium browser that holds the workspace's token and an AI Provider.
async function withRemoteTrio(spec, fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-295-e2e-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  try {
    writeTrio(definitionsDir)
    await withFakeAnthropic(trioScript, (aiBase, posts) =>
      withRunningServerForProvider(
        spec.provider,
        { options: { instancesDir, definitionsDir, allowPrivateAiUrls: true }, fakeServerOptions: { files: { [`/${ROOT}/instance.yaml`]: INSTANCE_YAML } } },
        async (ctx) => {
          registerInstance(SLUG, { kind: spec.kind, ...spec.location(ctx) }, { instancesDir })
          const browser = await launchBrowser()
          try {
            const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
            page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
            const pageErrors = []
            page.on('pageerror', (err) => pageErrors.push(err.message))
            const checks = []
            page.on('request', (req) => {
              if (req.url().includes('/api/instance/check-status')) checks.push(req.method())
            })
            await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), ctx.pat)
            await seedProviders(page, aiBase)
            const auth = { Authorization: basicAuthHeader(ctx.pat) }
            const api = (path, init = {}) => fetch(`${ctx.gantryBase}${path}${path.includes('?') ? '&' : '?'}slug=${SLUG}`, { ...init, headers: { ...auth, ...init.headers } })
            await fn({ page, base: ctx.gantryBase, ctx, posts, checks, client: spec.client(ctx), api })
            assert.deepEqual(pageErrors, [])
          } finally {
            await browser.close()
          }
        }
      )
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const row = (page, id) => page.locator(`[data-testid="run-plan-row"][data-stage-id="${id}"]`)
const states = (page) => page.locator('[data-testid="run-plan-row"]').evaluateAll((els) => els.map((e) => `${e.getAttribute('data-stage-id')}:${e.getAttribute('data-state')}${e.getAttribute('data-target') === 'true' ? '*' : ''}`))
const waitState = (page, id, state) => page.waitForSelector(`[data-testid="run-plan-row"][data-stage-id="${id}"][data-state="${state}"]`)
const pullRequestNumber = async (page) => Number((await page.textContent('[data-testid="interview-pr-link"]')).match(/#(\d+)/)[1])
const open = async (page, base) => {
  await page.goto(`${base}/instance/${SLUG}?interview=1`)
  await page.waitForSelector('[data-testid="interview-page"]')
}
// Kickoff to the first stage-end card of the Stage on the page, for a run until `target`.
async function draftStage(page, target) {
  await page.waitForSelector('[data-testid="interview-run-until"]')
  if (target) await page.selectOption('[data-testid="interview-run-until"]', target)
  await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
  await page.click('[data-testid="interview-start"]')
  await page.waitForSelector('[data-testid="interview-stage-end"]')
}

for (const spec of PROVIDERS) {
  test(`${spec.name}: a run saves Scope and requests approval, the row checks status once the Owner approves, and the session carries on to Shape`, async () => {
    await withRemoteTrio(spec, async ({ page, base, ctx, checks, client, api }) => {
      await open(page, base)
      await draftStage(page, 's2')

      // The stage-end card: the first choice asks for approval, and nothing advances by itself.
      assert.equal(await page.locator('[data-testid="interview-save-advance"]').count(), 0)
      assert.match(await page.textContent('[data-testid="interview-save-approval"]'), /Save, request approval, draft ahead/)
      assert.match(await page.textContent('[data-testid="interview-save-approval"]'), /RECOMMENDED/)
      assert.match(await page.textContent('[data-testid="interview-save"]'), /Save and stop here/)
      assert.match(await page.textContent('[data-testid="interview-approval-note"]'), /never passes a gate/)
      assert.deepEqual(await states(page), ['s1:awaiting-confirmation', 's2:waiting*', 's3:beyond'])

      await page.click('[data-testid="interview-save-approval"]')
      await page.waitForSelector('[data-testid="interview-awaiting-approval"]')
      await waitState(page, 's1', 'awaiting-approval')
      assert.deepEqual(await states(page), ['s1:awaiting-approval', 's2:waiting*', 's3:beyond'])
      const firstPr = await pullRequestNumber(page)
      assert.match(await page.getAttribute('[data-testid="interview-pr-link"]', 'href'), spec.prPath)
      assert.equal(await row(page, 's1').locator('[data-testid="run-plan-pr-link"]').count(), 1, 'the row links to the Pull Request')
      assert.match(await page.textContent('[data-testid="interview-awaiting-next"]'), /goes on to Shape, its target/)

      // On the Provider: one Save on the Stage's branch with the decisions log in it, and a Pull Request open; main is untouched.
      const branch = stageBranchName(SLUG, 's1')
      assert.match(await client.getFileContent(`${ROOT}/modules/m1.md`, { branch }), /Notes for s1/)
      const log = parseYAML(await client.getFileContent(`${ROOT}/interview/s1.yaml`, { branch }))
      assert.deepEqual([log.status[0].state, log.status[0].target], ['awaiting-approval', 's2'])
      assert.deepEqual(log.status[0].stages, { s1: 'awaiting-approval', s2: 'waiting' })
      assert.equal(await client.fileExists(`${ROOT}/interview/s1.yaml`, 'main'), false)
      assert.equal((await (await api('/api/instance')).json()).pullRequests.s1, firstPr)

      // Nothing polls: the session waits.
      await page.waitForTimeout(2500)
      assert.deepEqual(checks, [], 'no Check status ran on its own')

      // Clicking the row asks the Provider once. The Owner has not reviewed yet, so the session stays put and says so.
      await row(page, 's1').locator('.rp-title').click()
      await page.waitForSelector('[data-testid="interview-approval-message"]')
      assert.match(await page.textContent('[data-testid="interview-approval-message"]'), /Still pending: the Owner has not reviewed Pull Request #\d+ yet/)
      assert.equal(checks.length, 1)
      assert.deepEqual(await states(page), ['s1:awaiting-approval', 's2:waiting*', 's3:beyond'])

      // The Owner approves on the Provider. Gantry knows nothing until the architect asks again.
      assert.ok((await spec.approve(ctx, firstPr)).status < 300)
      await page.waitForTimeout(1000)
      assert.equal(checks.length, 1)
      await row(page, 's1').locator('.rp-title').click()

      // Merged: the Instance moves on to Shape and the AI starts it by itself (nobody pressed Start).
      await page.waitForSelector('[data-testid="interview-field"][data-field-key="m2.body"]')
      await page.waitForSelector('[data-testid="interview-stage-end"]')
      assert.equal(checks.length, 2)
      assert.deepEqual(await states(page), ['s1:done', 's2:awaiting-confirmation*', 's3:beyond'])
      assert.equal(await page.locator('[data-testid="interview-start"]').count(), 0)
      assert.equal((await (await api('/api/instance')).json()).currentStageId, 's2')

      // Shape is the target: one approval button, and the run is done at its Save while the Owner's approval is still to come.
      assert.match(await page.textContent('[data-testid="interview-save-approval"]'), /Save and request approval/)
      assert.doesNotMatch(await page.textContent('[data-testid="interview-save-approval"]'), /draft ahead/)
      await page.click('[data-testid="interview-save-approval"]')
      await page.waitForSelector('[data-testid="interview-awaiting-approval"]')
      assert.deepEqual(await states(page), ['s1:done', 's2:awaiting-approval*', 's3:beyond'])
      assert.match(await page.textContent('[data-testid="interview-awaiting-last"]'), /last Stage of the run/)
      const secondLog = parseYAML(await client.getFileContent(`${ROOT}/interview/s2.yaml`, { branch: stageBranchName(SLUG, 's2') }))
      assert.deepEqual([secondLog.status[0].state, secondLog.status[0].target], ['done', 's2'])
      assert.equal(checks.length, 2, 'asking for approval is not a Check status')
    })
  })

  test(`${spec.name}: opening the page on a Stage awaiting approval checks status once and shows the Provider's answer, and a merged Stage offers to resume the run`, async () => {
    await withRemoteTrio(spec, async ({ page, base, ctx, checks }) => {
      await open(page, base)
      await draftStage(page, 's2')
      await page.click('[data-testid="interview-save-approval"]')
      await page.waitForSelector('[data-testid="interview-awaiting-approval"]')
      const pr = await pullRequestNumber(page)
      assert.equal(checks.length, 0)

      // A second session in a fresh page: one Check status as it opens, and the run plan is restored from the log and the Provider.
      await open(page, base)
      await page.waitForSelector('[data-testid="interview-awaiting-approval"]')
      await page.waitForSelector('[data-testid="interview-approval-message"]')
      assert.match(await page.textContent('[data-testid="interview-approval-message"]'), /Still pending/)
      assert.equal(checks.length, 1, 'one Check status as the session resumed')
      assert.deepEqual(await states(page), ['s1:awaiting-approval', 's2:waiting*', 's3:beyond'], 'the run target comes back from the decisions log')
      assert.equal(await page.locator('[data-testid="interview-start"]').count(), 0, 'a Stage with a Pull Request open is not started again')
      await page.waitForTimeout(2000)
      assert.equal(checks.length, 1, 'and nothing polls after it')

      // The Owner approves; opening the page finds out (the Provider overrides the log), and the run is offered as a resume, not started.
      assert.ok((await spec.approve(ctx, pr)).status < 300)
      await open(page, base)
      await page.waitForSelector('[data-testid="interview-resume-note"]')
      assert.equal(checks.length, 2)
      assert.match(await page.textContent('[data-testid="interview-resume-note"]'), /run to Shape was paused/)
      assert.deepEqual(await states(page), ['s1:done', 's2:waiting*', 's3:beyond'])
      assert.equal(await page.locator('[data-testid="interview-field"][data-state="draft"]').count(), 0)
      await page.click('[data-testid="interview-resume"]')
      await page.waitForSelector('[data-testid="interview-field"][data-field-key="m2.body"]')
      await page.waitForSelector('[data-testid="interview-stage-end"]')
      assert.deepEqual(await states(page), ['s1:done', 's2:awaiting-confirmation*', 's3:beyond'])
    })
  })

  test(`${spec.name}: Save and stop here asks for nothing, and a second session's card names the commit author who last saved the Stage`, async () => {
    await withRemoteTrio(spec, async ({ page, base, checks, api }) => {
      await open(page, base)
      await draftStage(page, null)
      await page.click('[data-testid="interview-save"]')
      await page.waitForSelector('[data-testid="interview-saved"]')
      assert.equal((await (await api('/api/instance')).json()).pullRequests.s1, undefined, 'no Pull Request was opened')

      // Another session left the Stage unfinished (its status line is in the log on the Stage's branch). Starting a second one warns,
      // and names who last saved the Stage as the Provider records it: the commit author.
      const other = { status: { session: 's-other', who: 'a.colleague', target: 's1', state: 'in-progress', lastAiSave: '2026-11-02T10:00:00.000Z' } }
      assert.equal((await api('/api/instance/decisions?stage=s1', json('PUT', { decisions: other }))).status, 200)
      await open(page, base)
      await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
      await page.click('[data-testid="interview-start"]')
      await page.waitForSelector('[data-testid="interview-session-warning"]')
      assert.equal(await page.textContent('[data-testid="interview-last-saved-by"]'), spec.author)
      assert.match(await page.textContent('[data-testid="interview-last-saved-by-note"]'), /\(the commit author\)/)
      assert.match(await page.textContent('[data-testid="interview-other-session"]'), /by a\.colleague/)
      assert.deepEqual(checks, [], 'a Stage with no Pull Request has nothing to check')
    })
  })

  test(`${spec.name}: a Stage queued behind a pending one shows Approval queued, and its Pull Request opens when Check status sees the earlier one merge`, async () => {
    await withRemoteTrio(spec, async ({ page, base, ctx, checks, client, api }) => {
      // Scope is saved and awaiting approval; Shape was saved ahead of it and queued, as the AI interview does when a later Stage is ready first.
      const status = (state, session) => ({ status: { session, who: 'a.architect', target: 's2', state } })
      const save = (stage, decisions) => api(`/api/instance/modules?stage=${stage}`, json('PUT', { modules: { [`m${stage.slice(1)}`]: { status: 'draft', owner: '', fields: { body: `Notes for ${stage}: the agreed position, written out.` } } }, decisions }))
      assert.equal((await save('s1', status('awaiting-approval', 's-1'))).status, 200)
      const firstPr = (await (await api('/api/instance/request-approval', json('POST', {}))).json()).pullRequestId
      assert.equal((await save('s2', status('approval-queued', 's-2'))).status, 200)

      await open(page, base)
      await page.waitForSelector('[data-testid="interview-awaiting-approval"]')
      await waitState(page, 's2', 'approval-queued')
      assert.deepEqual(await states(page), ['s1:awaiting-approval', 's2:approval-queued*', 's3:beyond'])
      assert.equal(await row(page, 's2').locator('[data-testid="run-plan-pr-link"]').count(), 0)
      assert.equal(await row(page, 's2').getAttribute('role'), null, 'only an awaiting-approval row is a button')

      // The Owner approves Scope. Clicking its row merges it and, in the same Check status, opens Shape's Pull Request.
      assert.ok((await spec.approve(ctx, firstPr)).status < 300)
      await row(page, 's1').locator('.rp-title').click()
      await page.waitForSelector('[data-testid="interview-awaiting-approval"] [data-testid="interview-pr-link"]')
      await waitState(page, 's2', 'awaiting-approval')
      assert.deepEqual(await states(page), ['s1:done', 's2:awaiting-approval*', 's3:beyond'])
      const secondPr = await pullRequestNumber(page)
      assert.notEqual(secondPr, firstPr)
      assert.equal((await (await api('/api/instance')).json()).pullRequests.s2, secondPr)
      assert.equal(await page.locator('[data-testid="interview-start"]').count(), 0, 'Shape was already drafted and queued: the run does not draft it again')
      assert.equal(checks.length, 2, 'one as the page opened, one for the click')
      assert.ok(await client.branchExists(stageBranchName(SLUG, 's2')))
    })
  })
}

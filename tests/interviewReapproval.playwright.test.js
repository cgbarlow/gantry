import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { azureDevOpsOutPath, instanceDisplayName } from '../lib/instance.js'
import { stageBranchName } from '../lib/stageBranch.js'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { GITHUB_OWNER, GITHUB_REPOSITORY, ORGANIZATION, PROJECT, REPOSITORY, basicAuthHeader, withRunningServerForProvider } from './helpers/lifecycle.js'
import { seedProviders, withFakeAnthropic } from './helpers/interviewStandIn.js'
import { writeDuo } from './helpers/duoDefinition.js'

// #300 (parent #238, docs/adr/0069): the AI interview respects re-approval of earlier stages. Scope (`s1`) is approved through the real
// routes; Shape (`s2`) shares Scope's module, so the AI's rewording of `m1.body` can come only through a card that names the re-approval.
// A real gantry server and relay, a real (fake, in-process) Provider, a real Chromium page and a stand-in for Anthropic.

const SLUG = 'remote-duo'
const ROOT = `gantry-workspace/${SLUG}`
const INSTANCE_YAML = `definition: duo\nslug: ${SLUG}\nstage: s1\ndefinitionVersion: 1\n`
const SCOPE_NOTES = 'Notes for s1: the agreed position, written out.'
const REWORDED = 'Notes for s1, reworded by the AI: the position, tightened.'
const json = (method, body, headers = {}) => ({ method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

const PROVIDERS = [
  {
    name: 'Azure DevOps',
    provider: 'azure-devops',
    kind: 'azureDevOps',
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

// Shape: the AI drafts Shape's own Field and also rewords Scope's, which Scope's approved document prints.
const duoScript = (body) => {
  if (body.messages.length === 1) {
    return {
      text: 'Reading.',
      tools: [
        { id: 'd-m1', input: { field: 'm1.body', value: REWORDED } },
        { id: 'd-m2', input: { field: 'm2.body', value: 'Notes for s2: the agreed position, written out.' } },
      ],
    }
  }
  return { text: 'Drafted.' }
}

// Scope is saved with a rendered document, approved by the Owner and merged, so the Instance sits at Shape; one page then holds the token and an AI Provider.
async function withApprovedScope(spec, fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-300-e2e-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  try {
    writeDuo(definitionsDir)
    await withFakeAnthropic(duoScript, (aiBase) =>
      withRunningServerForProvider(
        spec.provider,
        { options: { instancesDir, definitionsDir, allowPrivateAiUrls: true }, fakeServerOptions: { files: { [`/${ROOT}/instance.yaml`]: INSTANCE_YAML } } },
        async (ctx) => {
          registerInstance(SLUG, { kind: spec.kind, ...spec.location(ctx) }, { instancesDir })
          const client = spec.client(ctx)
          const auth = { Authorization: basicAuthHeader(ctx.pat) }
          const api = (path, init = {}) => fetch(`${ctx.gantryBase}${path}${path.includes('?') ? '&' : '?'}slug=${SLUG}`, { ...init, headers: { ...auth, ...init.headers } })

          const save = await api('/api/instance/modules?stage=s1', json('PUT', { modules: { m1: { status: 'draft', owner: '', fields: { body: SCOPE_NOTES } } } }))
          assert.equal(save.status, 200)
          const documentPath = azureDevOpsOutPath(SLUG, instanceDisplayName({ slug: SLUG }), 'Scope document', 'docx')
          await client.writeFile(documentPath, 'rendered scope', { branch: stageBranchName(SLUG, 's1') })
          const opened = await (await api('/api/instance/request-approval', json('POST', {}))).json()
          assert.ok((await spec.approve(ctx, opened.pullRequestId)).status < 300)
          const merged = await (await api('/api/instance/check-status', json('POST', {}))).json()
          assert.equal(merged.merged, true)
          assert.equal((await (await api('/api/instance')).json()).currentStageId, 's2')

          const browser = await launchBrowser()
          try {
            const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
            page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
            const pageErrors = []
            page.on('pageerror', (err) => pageErrors.push(err.message))
            await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), ctx.pat)
            await seedProviders(page, aiBase)
            await fn({ page, base: ctx.gantryBase, ctx, client, api, documentPath })
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
// Opens Shape's interview, starts it, and waits for the card about Scope's approved Field.
async function startShape(page, base) {
  await page.goto(`${base}/instance/${SLUG}?interview=1`)
  await page.waitForSelector('[data-testid="interview-page"]')
  await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
  await page.click('[data-testid="interview-start"]')
  await page.waitForSelector('[data-testid="interview-card"][data-card-type="change"]')
  return page.locator('[data-testid="interview-card"][data-card-type="change"]')
}

for (const spec of PROVIDERS) {
  test(`${spec.name}: the AI's change to a Field Scope's approved document prints comes only through a card that names the re-approval, and confirming the stage-end card re-renders Scope's document before requesting approval`, async () => {
    await withApprovedScope(spec, async ({ page, base, client, api, documentPath }) => {
      const change = await startShape(page, base)

      // The card says what it does. Nothing of the AI's rewording is in the preview, and Shape's own Field is.
      assert.match((await change.locator('.qchip').first().textContent()).replace(/\s+/g, ' ').trim(), /^Needs re-approval · feeds Scope notes · Body$/)
      assert.match(await change.locator('[data-testid="card-question"]').textContent(), /Scope notes · Body is printed by Scope, which is already approved/)
      assert.match(await change.locator('[data-testid="card-question"]').textContent(), /changes approved content, so Scope needs re-approval with this Stage/)
      assert.match(await change.locator('[data-testid="change-reapproval"]').textContent(), /Scope is re-approved with this Stage: its documents are re-rendered and its approver must approve too/)
      assert.equal(await change.locator('[data-testid="change-saved"]').textContent(), SCOPE_NOTES)
      assert.equal(await change.locator('[data-testid="change-proposed"]').textContent(), REWORDED)
      assert.equal(await change.locator('[data-testid="card-option"][data-option="Keep"] [data-testid="card-recommended"]').count(), 1)
      assert.equal(await page.locator('[data-testid="interview-field"][data-field-key="m1.body"]').getAttribute('data-state'), 'saved')
      assert.equal(await page.locator('[data-testid="interview-field"][data-field-key="m2.body"]').getAttribute('data-state'), 'draft')
      assert.equal(await page.locator('[data-testid="interview-stage-end"]').count(), 0, 'the Stage is not ready while a card is open')
      assert.equal(await row(page, 's1').locator('[data-testid="run-plan-changed-since-approval"]').count(), 0, 'nothing has changed yet')

      // Choosing the AI's version puts it in the preview, and the stage-end card now says it re-renders Scope's document.
      await change.locator('[data-testid="card-option"][data-option="Use the AI\'s version"]').click()
      await page.click('[data-testid="round-submit"]')
      await page.waitForSelector('[data-testid="interview-stage-end"]')
      assert.equal(await page.locator('[data-testid="interview-field"][data-field-key="m1.body"]').getAttribute('data-state'), 'draft')
      assert.equal(await page.textContent('[data-testid="interview-rerender-note"]').then((t) => t.replace(/\s+/g, ' ')), 'Saving also re-renders Scope document from the changed wording, then asks for approval of this Stage and Scope together. The approved copies are kept in out/approved/. Choosing Save and stop here saves the content and leaves the documents as they are.')

      // One click: Save, re-render, request approval.
      await page.click('[data-testid="interview-save-approval"]')
      await page.waitForSelector('[data-testid="interview-awaiting-approval"]')
      assert.match(await page.textContent('[data-testid="interview-rerendered"]'), /Re-rendered Scope document onto this Stage's branch before asking, with the approved copy kept in out\/approved\/\. The Pull Request also re-approves Scope\./)

      // The run plan flags Scope.
      await row(page, 's1').locator('[data-testid="run-plan-changed-since-approval"]').waitFor()
      assert.equal((await row(page, 's1').locator('[data-testid="run-plan-changed-since-approval"]').textContent()).trim(), 'changed since approval')

      // On the Provider: the approved document is kept, the usual name holds the new render, and the Pull Request also re-approves Scope.
      const branch = stageBranchName(SLUG, 's2')
      const kept = (await client.listFolder(`${ROOT}/out/approved`, { branch })).filter((item) => item.path.endsWith('.docx'))
      assert.equal(kept.length, 1)
      assert.match(kept[0].path, / — approved /)
      assert.equal((await client.getFileBytes(kept[0].path, { branch })).toString(), 'rendered scope')
      const renewed = await client.getFileBytes(documentPath, { branch })
      assert.equal(renewed.subarray(0, 2).toString(), 'PK', 'a real Word document took the usual name')
      const instance = await (await api('/api/instance')).json()
      assert.equal(instance.alsoReapproving?.[0]?.stageId, 's1')
      assert.deepEqual(instance.changedSinceApproval.map((e) => [e.stageId, e.fields]), [['s1', ['m1.body']]])

      // The decisions log keeps the choice, with the Stage it re-approves.
      const log = parseYAML(await client.getFileContent(`${ROOT}/interview/s2.yaml`, { branch }))
      const entry = log.entries.find((e) => e.kind === 'saved-content')
      assert.equal(entry.choice, 'replace')
      assert.equal(entry.field, 'm1.body')
      assert.deepEqual(entry.reapproves, [{ stageId: 's1', title: 'Scope' }])
    })
  })

  test(`${spec.name}: keeping the approved wording leaves Scope alone: no re-render, no second approver, and the choice is logged`, async () => {
    await withApprovedScope(spec, async ({ page, base, client, api }) => {
      await startShape(page, base)
      await page.click('[data-testid="round-submit"]') // Keep is the recommendation
      await page.waitForSelector('[data-testid="interview-stage-end"]')
      assert.equal(await page.locator('[data-testid="interview-rerender-note"]').count(), 0)
      assert.equal(await page.locator('[data-testid="interview-field"][data-field-key="m1.body"]').getAttribute('data-state'), 'saved')

      await page.click('[data-testid="interview-save-approval"]')
      await page.waitForSelector('[data-testid="interview-awaiting-approval"]')
      assert.equal(await page.locator('[data-testid="interview-rerendered"]').count(), 0)
      assert.equal(await row(page, 's1').locator('[data-testid="run-plan-changed-since-approval"]').count(), 0)
      const instance = await (await api('/api/instance')).json()
      assert.deepEqual(instance.changedSinceApproval, [])
      assert.deepEqual(instance.alsoReapproving ?? [], [])
      assert.equal(await client.fileExists(`${ROOT}/out/approved/.gantry-reapproval.json`, stageBranchName(SLUG, 's2')), false)

      const log = parseYAML(await client.getFileContent(`${ROOT}/interview/s2.yaml`, { branch: stageBranchName(SLUG, 's2') }))
      const entry = log.entries.find((e) => e.kind === 'saved-content')
      assert.equal(entry.choice, 'keep')
      assert.deepEqual(entry.reapproves, [{ stageId: 's1', title: 'Scope' }])
    })
  })
}

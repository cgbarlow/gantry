import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createAzureDevOpsPullRequestsClient } from '../lib/azureDevOpsPullRequestsClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { loadDefinition } from '../lib/definition.js'
import { resolveStageBranch } from '../lib/stageBranch.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, basicAuthHeader, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #144 (docs/adr/0014, docs/adr/0026): the notice on the current stage's page when its approval Pull Request has been
// merged on the Provider but Gantry hasn't recorded it, and its two one-click actions.

const SLUG = 'hire'
const definition = loadDefinition('design')
const [SHAPE] = definition.stages
const auth = { Authorization: basicAuthHeader(VALID_PAT) }

async function withMergedShape({ laterStageBranch = false }, fn) {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-merged-approval-e2e-'))
      try {
        registerInstance(SLUG, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
        const client = createAzureDevOpsClient(azureDevOps)
        const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
        for (const moduleId of ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']) {
          await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, exampleModuleText(moduleId), { branch })
        }
        await client.writeFile(`gantry-workspace/${SLUG}/out/Hire - Solution on a Page.docx`, 'rendered soap', { branch })

        await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true, allowedAzureDevOpsBaseUrls: [adoBaseUrl] }, async (gantryBase) => {
          const opened = await (await fetch(`${gantryBase}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers: auth })).json()
          // Someone completes the Pull Request on the Provider itself; the stage branch goes with it.
          await createAzureDevOpsPullRequestsClient(azureDevOps).completePullRequest(opened.pullRequestId, {})
          const oid = await client.getBranchObjectId(branch)
          await fetch(`${adoBaseUrl.replace(/\/+$/, '')}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/refs?api-version=7.1`, {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify([{ name: `refs/heads/${branch}`, oldObjectId: oid, newObjectId: '0'.repeat(40) }]),
          })
          if (laterStageBranch) await client.createBranch(`gantry-workspace/${SLUG}/hld-define`)

          const browser = await launchBrowser()
          try {
            const page = await browser.newPage()
            page.setDefaultTimeout(DEFAULT_TIMEOUT)
            const pageErrors = []
            page.on('pageerror', (err) => pageErrors.push(err.message))
            await page.addInitScript((pat) => {
              localStorage.setItem('gantry:ado-pat', pat)
            }, VALID_PAT)
            await page.goto(`${gantryBase}/instance/${SLUG}`)
            await page.waitForSelector('.module', { timeout: 10_000 })
            await fn({ page, gantryBase, client, branch, pullRequestId: opened.pullRequestId })
            assert.deepEqual(pageErrors, [])
          } finally {
            await browser.close()
          }
        })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
}

const currentStageOf = async (gantryBase) => (await (await fetch(`${gantryBase}/api/instance?slug=${SLUG}`, { headers: auth })).json()).currentStageId

test('a merged-but-unrecorded approval shows a notice on load, records nothing, and "Record approval and move on" advances the instance', async () => {
  await withMergedShape({}, async ({ page, gantryBase, pullRequestId }) => {
    const panel = page.locator('[data-testid="merged-approval-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 10_000 })
    assert.match(await panel.textContent(), new RegExp(`Pull Request #${pullRequestId}`))
    assert.equal(await page.locator('[data-testid="record-approval-reopen"]').isEnabled(), true)
    assert.equal(await currentStageOf(gantryBase), 'shape', 'loading the page recorded nothing')

    await page.locator('[data-testid="record-approval-advance"]').click()
    await page.locator('[data-testid="merged-approval-panel"]').waitFor({ state: 'detached', timeout: 15_000 })
    assert.equal(await currentStageOf(gantryBase), 'hld-define')
  })
})

test('"Record approval and re-open for changes" leaves the instance on the stage with a fresh branch', async () => {
  await withMergedShape({}, async ({ page, gantryBase, client, branch }) => {
    await page.locator('[data-testid="merged-approval-panel"]').waitFor({ state: 'visible', timeout: 10_000 })
    await page.locator('[data-testid="record-approval-reopen"]').click()
    await page.locator('[data-testid="merged-approval-panel"]').waitFor({ state: 'detached', timeout: 15_000 })
    assert.equal(await currentStageOf(gantryBase), 'shape')
    assert.equal(await client.branchExists(branch), true)
    const instance = await (await fetch(`${gantryBase}/api/instance?slug=${SLUG}`, { headers: auth })).json()
    assert.ok(instance.reopened.shape)
  })
})

test('re-open is shown disabled with the reason when a later stage already has a branch (ADR-0026 guard); moving on still works', async () => {
  await withMergedShape({ laterStageBranch: true }, async ({ page, gantryBase }) => {
    await page.locator('[data-testid="merged-approval-panel"]').waitFor({ state: 'visible', timeout: 10_000 })
    assert.equal(await page.locator('[data-testid="record-approval-reopen"]').isDisabled(), true)
    assert.match(await page.locator('[data-testid="record-approval-reopen-reason"]').textContent(), /Stage 'hld-define' is already in progress/)
    assert.equal(await page.locator('[data-testid="record-approval-advance"]').isEnabled(), true)

    await page.locator('[data-testid="record-approval-advance"]').click()
    await page.locator('[data-testid="merged-approval-panel"]').waitFor({ state: 'detached', timeout: 15_000 })
    assert.equal(await currentStageOf(gantryBase), 'hld-define')
  })
})

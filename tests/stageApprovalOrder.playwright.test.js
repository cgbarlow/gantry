import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { loadDefinition } from '../lib/definition.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createAzureDevOpsPullRequestsClient } from '../lib/azureDevOpsPullRequestsClient.js'
import { resolveStageBranch } from '../lib/stageBranch.js'
import { readInstance, recordInstancePullRequest } from '../lib/instance.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, withScratchInstances, basicAuthHeader, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #266, ADR-0063: what a person sees when approvals-in-order refuses or holds back a stage. The Work item
// details card never sends a gate itself (it always acts on the instance's current stage), so the situation
// only arises when the instance moved on under an open page, or another client asked for a later stage.
// To reproduce that without faking the server, these tests let the browser's own request go to the real
// gantry server and the real (in-process) fake Azure DevOps server, but rewrite that one request's body to
// name the next stage's gate. The refusal and the "waits for the earlier stage" answer are the server's own.

const SLUG = 'ordered-initiative'

const definition = loadDefinition('design')
const [SHAPE, HLD_DEFINE] = definition.stages

async function fillShapeStage(azureDevOps, branch) {
  const client = createAzureDevOpsClient(azureDevOps)
  for (const moduleId of ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']) {
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, exampleModuleText(moduleId), { branch })
  }
  await client.writeFile(`gantry-workspace/${SLUG}/out/Ordered Initiative - Solution on a Page.docx`, 'rendered soap', { branch })
  await client.writeFile(`gantry-workspace/${SLUG}/out/Ordered Initiative - Full Solution on a Page.docx`, 'rendered full soap', { branch })
}

async function castVote(adoBaseUrl, pullRequestId, vote) {
  const res = await fetch(
    `${adoBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}/reviewers/owner-1`,
    {
      method: 'PUT',
      headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'The Owner', vote }),
    }
  )
  assert.equal(res.status, 200)
}

function withRemoteInstance(fn) {
  return withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\ndefinitionVersion: 2\n` },
    },
    async (adoBaseUrl) => {
      await withScratchInstances(async (instancesDir) => {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )
        await fn({ adoBaseUrl, instancesDir })
      })
    }
  )
}

async function withOpenPage(base, fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => {
      // The deliberate 400 is logged by the browser as a failed resource load; it is not a script error.
      if (msg.type() === 'error' && !/status of 400/.test(msg.text())) pageErrors.push(msg.text())
    })
    await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)
    // #301 — the Work item details card renders only while advanced mode is on.
    await page.addInitScript(() => localStorage.setItem('gantry:advancedMode', 'true'))
    await page.goto(`${base}/instance/${SLUG}`)
    await fn(page)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

// Sends the next POST to `pathPattern` with `{ gate }` as its body instead of the empty one the card sends.
async function aimNextRequestAtGate(page, pathPattern, gate) {
  await page.route(pathPattern, (route) => route.continue({ postData: JSON.stringify({ gate }) }), { times: 1 })
}

test('Request Sign-off for a stage that is not current shows the refusal naming the current stage, and opens no Pull Request', async () => {
  await withRemoteInstance(async ({ adoBaseUrl, instancesDir }) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    await fillShapeStage(azureDevOps, branch)

    await withRunningServer({ instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
      await withOpenPage(base, async (page) => {
        const panel = page.locator('.signoff-section')
        await panel.waitFor({ timeout: 10_000 })

        await panel.getByRole('button', { name: 'Request Sign-off' }).click()
        const modal = page.locator('.modal[aria-label="Confirm request sign-off"]')
        await modal.waitFor({ state: 'visible', timeout: 10_000 })

        await aimNextRequestAtGate(page, '**/api/instance/request-approval*', HLD_DEFINE.gate)
        await modal.getByRole('button', { name: 'Confirm & request sign-off' }).click()

        await assert.doesNotReject(
          panel.getByText(new RegExp(`Request sign-off failed: .*current stage is "${SHAPE.title}" \\(stage "shape"\\).*approved in order`)).waitFor({ timeout: 10_000 })
        )
        assert.equal(await panel.getByText(/Pull Request #\d+ is open/).count(), 0)
        // The button is still offered: nothing was opened, so the stage can still be requested properly.
        assert.equal(await panel.getByRole('button', { name: 'Request Sign-off' }).count(), 1)
      })

      // And on the provider: no Pull Request was recorded for either stage.
      const instance = await readInstance(SLUG, { azureDevOps })
      assert.equal(instance.pullRequests?.[SHAPE.id], undefined)
      assert.equal(instance.pullRequests?.[HLD_DEFINE.id], undefined)
    })
  })
})

test('Check status on an approved Pull Request for a stage that is not current shows that it waits for the earlier stage, and merges nothing', async () => {
  await withRemoteInstance(async ({ adoBaseUrl, instancesDir }) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    await fillShapeStage(azureDevOps, branch)

    await withRunningServer({ instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
      await withOpenPage(base, async (page) => {
        const card = page.locator('#work-item-detail-card')
        const panel = page.locator('.signoff-section')
        await panel.waitFor({ timeout: 10_000 })

        // Open the current stage's own Pull Request through the page, so Check status is offered.
        await panel.getByRole('button', { name: 'Request Sign-off' }).click()
        const modal = page.locator('.modal[aria-label="Confirm request sign-off"]')
        await modal.waitFor({ state: 'visible', timeout: 10_000 })
        await modal.getByRole('button', { name: 'Confirm & request sign-off' }).click()
        await assert.doesNotReject(panel.locator('text=/Pull Request #\\d+ is open/').waitFor({ timeout: 10_000 }))

        // Meanwhile the next stage has been drafted ahead on a branch stacked on this one, and its Pull
        // Request approved. Approving it must not carry this stage's unapproved work into main.
        const hldBranch = await resolveStageBranch(azureDevOps, definition, SLUG, HLD_DEFINE.id)
        const prClient = createAzureDevOpsPullRequestsClient(azureDevOps)
        const pr = await prClient.createPullRequest({ sourceBranch: hldBranch, targetBranch: 'main', title: 'hld', description: '' })
        await recordInstancePullRequest(SLUG, HLD_DEFINE.id, pr.pullRequestId, {
          azureDevOps: { ...azureDevOps, branch: hldBranch },
          pullRequestStatus: pr.status,
        })
        await castVote(adoBaseUrl, pr.pullRequestId, 10)

        await aimNextRequestAtGate(page, '**/api/instance/check-status*', HLD_DEFINE.gate)
        await card.locator('.panel-header').getByRole('button', { name: 'Check status' }).click()

        await assert.doesNotReject(
          card.getByText(/Stage "hld-define" is approved but waits for the earlier stage "shape".*Nothing was merged or advanced/).waitFor({ timeout: 10_000 })
        )
        assert.equal(await page.getByText(/merged; stage advanced to/).count(), 0)
        // Still on the first stage.
        await assert.doesNotReject(page.locator('#stage-line', { hasText: SHAPE.title }).waitFor({ timeout: 5_000 }))
      })

      const instance = await readInstance(SLUG, { azureDevOps })
      assert.equal(instance.stage, SHAPE.id)
      assert.equal(await createAzureDevOpsClient(azureDevOps).fileExists(`gantry-workspace/${SLUG}/modules/background.md`), false)
    })
  })
})

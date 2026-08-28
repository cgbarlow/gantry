import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser } from './helpers/launchBrowser.js'
import { createServer } from '../lib/server.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { createAzureDevOpsWorkItemsClient } from '../lib/azureDevOpsWorkItemsClient.js'
import { requestStageReview, checkStageReviewStatus } from '../lib/stageReview.js'
import { REVIEW_STATUS_FIELD } from '../lib/reviewStatus.js'
import { linkInstanceToWorkItem } from '../lib/workItemLink.js'
import { recordInstanceReviewRequest } from '../lib/instance.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

const ORGANIZATION = 'review-org'
const PROJECT = 'review-project'
const REPOSITORY = 'review-repo'
const PAT = 'valid-test-pat'
const SLUG = 'review-initiative'

function authHeader(pat) {
  return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`
}

function withRunningServer(options, fn) {
  return new Promise((resolve, reject) => {
    const server = createServer(options)
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn(`http://localhost:${port}`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

test('Request Review creates independently tracked related Tasks and checks native status on demand', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: PAT,
      files: {
        [`/gantry-workspace/${SLUG}/instance.yaml`]:
          `definition: design\nslug: ${SLUG}\nstage: shape\nassignee: requester@example.com\n`,
      },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-review-instances-'))
      try {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir },
        )
        const client = createAzureDevOpsWorkItemsClient({ organization: ORGANIZATION, project: PROJECT, pat: PAT, baseUrl: adoBaseUrl })
        const parent = await client.createWorkItem('Feature', { 'System.Title': 'Parent initiative' })

        await withRunningServer({ instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          const link = await fetch(`${base}/api/instance/work-items/link?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: authHeader(PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, parentId: parent.id, baseUrl: adoBaseUrl }),
          }).then((res) => res.json())

          const request = await fetch(`${base}/api/instance/request-review?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: authHeader(PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape', reviewer: 'testuser@example.com' }),
          })
          assert.equal(request.status, 200)
          const requested = await request.json()
          // ADR-0024: newly created review Tasks are set to "Requested" in
          // the new custom field, not left on native System.State.
          assert.equal(requested.review.status, 'Requested')
          assert.match(requested.webUrl, new RegExp(`/_workitems/edit/${requested.review.workItemId}$`))

          const reviewWorkItem = await client.getWorkItem(requested.review.workItemId, { expand: 'relations' })
          assert.equal(reviewWorkItem.fields['System.WorkItemType'], 'Task')
          assert.equal(reviewWorkItem.fields['System.AssignedTo'], 'testuser@example.com')
          assert.match(reviewWorkItem.fields['System.Description'], /Requested by requester@example.com/)
          assert.match(reviewWorkItem.fields['System.Description'], new RegExp(`/instance/${SLUG}\\?stage=shape`))
          assert.equal(reviewWorkItem.relations[0].rel, 'System.LinkTypes.Related')
          assert.ok(reviewWorkItem.relations[0].url.endsWith(`/workItems/${link.stages.shape}`))
          // Additive: native System.State is untouched (still the Task
          // type's default), only the new custom field carries the
          // lifecycle value.
          assert.equal(reviewWorkItem.fields['System.State'], 'New')
          assert.equal(reviewWorkItem.fields[REVIEW_STATUS_FIELD], 'Requested')

          // A reviewer's decision (e.g. asking for changes) is recorded on
          // the custom field directly — System.State stays put.
          await client.updateWorkItem(requested.review.workItemId, { [REVIEW_STATUS_FIELD]: 'Changes requested' })
          const status = await fetch(`${base}/api/instance/review-status?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: authHeader(PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape', reviewId: requested.review.workItemId }),
          })
          assert.equal(status.status, 200)
          assert.equal((await status.json()).review.status, 'Changes requested')

          const stateAfterDecision = await client.getWorkItem(requested.review.workItemId)
          assert.equal(stateAfterDecision.fields['System.State'], 'New')

          const instance = await fetch(`${base}/api/instance?slug=${SLUG}`, { headers: { Authorization: authHeader(PAT) } }).then((res) => res.json())
          assert.equal(instance.reviews.length, 1)
          assert.equal(instance.reviews[0].status, 'Changes requested')
          assert.equal(instance.reviewRequests.shape[0].workItemId, requested.review.workItemId)
        })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    },
  )
})

test('requestStageReview and checkStageReviewStatus require options.azureDevOps, mirroring every other Workspace-backed-only action', async () => {
  await assert.rejects(
    () => requestStageReview(SLUG, { reviewer: 'a@example.com' }, {}),
    /Stage review actions are for Workspace-backed instances only — pass options.azureDevOps/
  )
  await assert.rejects(
    () => checkStageReviewStatus(SLUG, { reviewId: '1' }, {}),
    /Stage review actions are for Workspace-backed instances only — pass options.azureDevOps/
  )
})

test('Request Review rejects local instances without requiring a PAT', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-review-local-'))
  try {
    const { createInstance } = await import('../lib/instance.js')
    createInstance('design', 'local-review', { instancesDir })
    await withRunningServer({ instancesDir }, async (base) => {
      const response = await fetch(`${base}/api/instance/request-review?slug=local-review`, { method: 'POST' })
      assert.equal(response.status, 400)
      assert.match((await response.json()).error, /not Workspace-backed/)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('Review status check rejects local instances without requiring a PAT', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-review-status-local-'))
  try {
    const { createInstance } = await import('../lib/instance.js')
    createInstance('design', 'local-review', { instancesDir })
    await withRunningServer({ instancesDir }, async (base) => {
      const response = await fetch(`${base}/api/instance/review-status?slug=local-review`, { method: 'POST' })
      assert.equal(response.status, 400)
      assert.match((await response.json()).error, /not Workspace-backed/)
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('Request Review and Review status both require an Azure DevOps credential for Workspace-backed instances', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-review-nocred-'))
      try {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir },
        )
        await withRunningServer({ instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          const requestReview = await fetch(`${base}/api/instance/request-review?slug=${SLUG}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape', reviewer: 'testuser@example.com' }),
          })
          assert.equal(requestReview.status, 401)

          const reviewStatus = await fetch(`${base}/api/instance/review-status?slug=${SLUG}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape', reviewId: 1 }),
          })
          assert.equal(reviewStatus.status, 401)
        })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    },
  )
})

test('Request Review reports an unresolvable reviewer without creating a Task, and rejects when the identity lookup itself is unauthorized', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
      rejectIdentityRequests: true,
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-review-badreviewer-'))
      try {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir },
        )
        const client = createAzureDevOpsWorkItemsClient({ organization: ORGANIZATION, project: PROJECT, pat: PAT, baseUrl: adoBaseUrl })
        const parent = await client.createWorkItem('Feature', { 'System.Title': 'Parent initiative' })

        await withRunningServer({ instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          await fetch(`${base}/api/instance/work-items/link?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: authHeader(PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, parentId: parent.id, baseUrl: adoBaseUrl }),
          })

          // The fake server's identity endpoint is configured to reject
          // every lookup with a 403 — mirrors a PAT missing identity-read
          // scope, distinct from a reviewer that simply doesn't resolve.
          const response = await fetch(`${base}/api/instance/request-review?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: authHeader(PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape', reviewer: 'testuser@example.com' }),
          })
          assert.equal(response.status, 401)
          const body = await response.json()
          assert.equal(body.credentialRejected, true)
          assert.equal(body.operation, 'resolving the reviewer for Request Review')
        })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    },
  )
})

test('Request Review rejects a reviewer that does not resolve to any known identity, without creating a Task', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-review-noresolve-'))
      try {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir },
        )
        const client = createAzureDevOpsWorkItemsClient({ organization: ORGANIZATION, project: PROJECT, pat: PAT, baseUrl: adoBaseUrl })
        const parent = await client.createWorkItem('Feature', { 'System.Title': 'Parent initiative' })

        await withRunningServer({ instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          await fetch(`${base}/api/instance/work-items/link?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: authHeader(PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, parentId: parent.id, baseUrl: adoBaseUrl }),
          })

          const response = await fetch(`${base}/api/instance/request-review?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: authHeader(PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape', reviewer: 'nobody-matches-this-query' }),
          })
          assert.equal(response.status, 400)
          assert.match((await response.json()).error, /could not be resolved to a known Azure DevOps identity/)

          const instance = await fetch(`${base}/api/instance?slug=${SLUG}`, { headers: { Authorization: authHeader(PAT) } }).then((res) => res.json())
          assert.equal(instance.reviews.length, 0)
        })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    },
  )
})

test('Request Review requires a reviewer and rejects a stage that has no linked work item', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-review-nolink-'))
      try {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir },
        )
        await withRunningServer({ instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          const missingReviewer = await fetch(`${base}/api/instance/request-review?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: authHeader(PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape', reviewer: '   ' }),
          })
          assert.equal(missingReviewer.status, 400)
          assert.match((await missingReviewer.json()).error, /A reviewer is required/)

          // No work item was ever linked for this instance's "shape" stage.
          const noLinkedWorkItem = await fetch(`${base}/api/instance/request-review?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: authHeader(PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape', reviewer: 'testuser@example.com' }),
          })
          assert.equal(noLinkedWorkItem.status, 400)
          assert.match((await noLinkedWorkItem.json()).error, /has no linked work item for stage "shape"/)
        })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    },
  )
})

test('Request Review attributes the requester from Azure DevOps connection data when available, ahead of the instance assignee fallback', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: PAT,
      files: {
        [`/gantry-workspace/${SLUG}/instance.yaml`]:
          `definition: design\nslug: ${SLUG}\nstage: shape\nassignee: fallback-assignee@example.com\n`,
      },
      connectionDataUser: {
        customDisplayName: 'Authenticated Requester',
        properties: { Account: { $type: 'System.String', $value: 'requester@example.com' } },
      },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-review-requester-'))
      try {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir },
        )
        const client = createAzureDevOpsWorkItemsClient({ organization: ORGANIZATION, project: PROJECT, pat: PAT, baseUrl: adoBaseUrl })
        const parent = await client.createWorkItem('Feature', { 'System.Title': 'Parent initiative' })

        await withRunningServer({ instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          await fetch(`${base}/api/instance/work-items/link?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: authHeader(PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, parentId: parent.id, baseUrl: adoBaseUrl }),
          })

          const response = await fetch(`${base}/api/instance/request-review?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: authHeader(PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape', reviewer: 'testuser@example.com' }),
          })
          assert.equal(response.status, 200)
          const requested = await response.json()
          const reviewWorkItem = await client.getWorkItem(requested.review.workItemId)
          assert.match(reviewWorkItem.fields['System.Description'], /Requested by Authenticated Requester\./)
          assert.doesNotMatch(reviewWorkItem.fields['System.Description'], /fallback-assignee@example\.com/)
        })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    },
  )
})

test('Request Review rejects a stage other than the instance\'s current stage', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-review-wrongstage-'))
      try {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir },
        )
        await withRunningServer({ instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          // The instance's persisted stage is "shape"; requesting a review
          // for a different, later stage id must be rejected before any
          // Azure DevOps Task is created.
          const response = await fetch(`${base}/api/instance/request-review?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: authHeader(PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'hld-define', reviewer: 'testuser@example.com' }),
          })
          assert.equal(response.status, 400)
          assert.match((await response.json()).error, /Review requests are only available for the instance's current stage \("shape"\)/)
        })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    },
  )
})

test('Review status check rejects an invalid review id and a review id with no matching request', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-review-badid-'))
      try {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir },
        )
        await withRunningServer({ instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          const notANumber = await fetch(`${base}/api/instance/review-status?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: authHeader(PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape', reviewId: 'not-a-number' }),
          })
          assert.equal(notANumber.status, 400)
          assert.match((await notANumber.json()).error, /A valid review work item id is required/)

          const noSuchReview = await fetch(`${base}/api/instance/review-status?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: authHeader(PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ stage: 'shape', reviewId: 999999 }),
          })
          assert.equal(noSuchReview.status, 400)
          assert.match((await noSuchReview.json()).error, /has no review request for work item #999999 on stage "shape"/)
        })
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    },
  )
})

test('the Workspace-backed screen exposes Review / Sign-off labels and the Request Review dialog', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-review-browser-'))
      const browser = await launchBrowser()
      try {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir },
        )
        const client = createAzureDevOpsWorkItemsClient({ organization: ORGANIZATION, project: PROJECT, pat: PAT, baseUrl: adoBaseUrl })
        const parent = await client.createWorkItem('Feature', { 'System.Title': 'Parent initiative' })

        await withRunningServer({ instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          const linkResponse = await fetch(`${base}/api/instance/work-items/link?slug=${SLUG}`, {
            method: 'POST',
            headers: { Authorization: authHeader(PAT), 'Content-Type': 'application/json' },
            body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, parentId: parent.id, baseUrl: adoBaseUrl }),
          })
          assert.equal(linkResponse.status, 200)

          const page = await browser.newPage()
          try {
            await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), PAT)
            await page.goto(`${base}/instance/${SLUG}`)
            await page.locator('.request-review-panel').waitFor({ timeout: 10_000 })
            assert.equal(await page.getByRole('button', { name: 'Review / Sign-off' }).count(), 1)
            assert.equal(await page.locator('.request-approval-panel').getByRole('button', { name: 'Request Sign-off' }).count(), 1)

            await page.locator('.request-review-panel').getByRole('button', { name: 'Request Review' }).click()
            const dialog = page.locator('.modal[aria-label="Request Review"]')
            await dialog.waitFor({ state: 'visible', timeout: 5_000 })
            await dialog.locator('.identity-picker input').pressSequentially('testuser@example.com')
            await dialog.getByRole('button', { name: /Test User/ }).click()
            await dialog.getByRole('button', { name: 'Send request' }).click()
            await dialog.getByText(/Work item #\d+/).waitFor({ timeout: 10_000 })
            await dialog.getByRole('button', { name: 'Add reviewer' }).click()
            assert.equal(await dialog.locator('.identity-picker input').count(), 2)

            // The sent row's own "Check status" button re-checks that one
            // review independently of any other row (#197's "independent
            // reviewer rows").
            const sentRow = dialog.locator('.review-request-row').filter({ hasText: 'Work item #' })
            await sentRow.getByRole('button', { name: 'Check status' }).click()
            await sentRow.getByText('Requested').waitFor({ timeout: 10_000 })

            await dialog.getByRole('button', { name: 'Close' }).click()
            await dialog.waitFor({ state: 'hidden', timeout: 5_000 })

            // The Work item details status card (#197) surfaces the same
            // review outside the dialog, with its own independent status
            // check action.
            const statusCard = page.locator('.review-status-card')
            await statusCard.waitFor({ timeout: 10_000 })
            const statusRow = statusCard.locator('.review-status-list li')
            assert.equal(await statusRow.count(), 1)
            await statusRow.getByRole('button', { name: 'Check status' }).click()
            await page.getByText(/Review #\d+ is Requested\./).waitFor({ timeout: 10_000 })
          } finally {
            await page.close()
          }
        })
      } finally {
        await browser.close()
        rmSync(instancesDir, { recursive: true, force: true })
      }
    },
  )
})

test('checkStageReviewStatus infers Requested/In review from native System.State for a review Task that predates REVIEW_STATUS_FIELD (ADR-0024 §4)', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-review-legacy-'))
      try {
        registerInstance(
          SLUG,
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir },
        )
        const client = createAzureDevOpsWorkItemsClient({ organization: ORGANIZATION, project: PROJECT, pat: PAT, baseUrl: adoBaseUrl })
        const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: PAT, baseUrl: adoBaseUrl }

        await linkInstanceToWorkItem(
          SLUG,
          { organization: ORGANIZATION, project: PROJECT, parentId: 1, workItemType: 'Task', pat: PAT, baseUrl: adoBaseUrl },
          { azureDevOps },
        )

        // A review Task created the old way — no REVIEW_STATUS_FIELD set at
        // all, exactly like every review Task created before ADR-0024.
        const legacyReview = await client.createWorkItem('Task', {
          'System.Title': 'Review requested: SOAP — review-initiative',
          'System.AssignedTo': 'legacy-reviewer@example.com',
        })
        assert.equal(legacyReview.fields[REVIEW_STATUS_FIELD], undefined)
        await recordInstanceReviewRequest(
          SLUG,
          'shape',
          { workItemId: legacyReview.id, reviewer: 'legacy-reviewer@example.com', reviewerDisplayName: 'Legacy Reviewer', status: 'New' },
          { azureDevOps },
        )

        // Native state is still "New" (the Task type's default) — no
        // forced backfill migration, just a graceful inference.
        const whileNew = await checkStageReviewStatus(SLUG, { reviewId: legacyReview.id, stageId: 'shape' }, { azureDevOps })
        assert.equal(whileNew.review.status, 'Requested')

        // Once someone picks it up (native state moves to Active, still no
        // custom field), the inferred status follows — still never an
        // error or blank value.
        await client.updateWorkItem(legacyReview.id, { 'System.State': 'Active' })
        const whileActive = await checkStageReviewStatus(SLUG, { reviewId: legacyReview.id, stageId: 'shape' }, { azureDevOps })
        assert.equal(whileActive.review.status, 'In review')
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    },
  )
})

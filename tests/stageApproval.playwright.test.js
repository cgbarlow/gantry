import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { createServer } from '../lib/server.js'
import { createInstance } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { loadDefinition } from '../lib/definition.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { resolveStageBranch } from '../lib/stageBranch.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// Browser smoke test for #124's sign-off flow — the Workspace-backed
// counterpart to tests/stageAdvancement.playwright.test.js's own
// Stage-advancement-panel coverage. #213 folded the old standalone
// RequestApprovalPanel into the Work Item Detail card (web/app.js's
// SyncedFieldsPanel) as its `.signoff-section` sub-section, with the
// card's own top-of-card "Check status" button (`#work-item-detail-card
// .panel-header`) replacing the section's former per-section one — opens a
// real Pull Request from the stage's own branch once its gate has passed,
// driven through a real rendered page against a real running gantry server
// and a real (fake, in-process) Azure DevOps server. Nothing mocked at the
// browser or HTTP layer.

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'
const SLUG = 'remote-initiative'

const definition = loadDefinition('design')
const [SHAPE] = definition.stages

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

function withScratchInstances(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  return (async () => fn(instancesDir))().finally(() => rmSync(instancesDir, { recursive: true, force: true }))
}

async function fillShapeStage(azureDevOps, branch) {
  const client = createAzureDevOpsClient(azureDevOps)
  for (const moduleId of ['background', 'introduction', 'solution-definition', 'team-and-estimates']) {
    const text = readFileSync(join('instances', 'examples', 'modules', `${moduleId}.md`), 'utf8')
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, text, { branch })
  }
  await client.writeFile(`gantry-workspace/${SLUG}/out/Remote Initiative - Solution on a Page.docx`, 'rendered soap', { branch })
  await client.writeFile(`gantry-workspace/${SLUG}/out/Remote Initiative - Full Solution on a Page.docx`, 'rendered full soap', { branch })
}

// Casts the Owner's reviewer vote directly against the fake Azure DevOps
// server — the same act as approving/rejecting in Azure DevOps's own UI
// (ADR-0014 keeps voting out of gantry entirely), so the browser test below
// exercises Check status's detection against a genuinely external decision.
async function castVote(adoBaseUrl, pullRequestId, vote) {
  const res = await fetch(
    `${adoBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}/reviewers/owner-1`,
    {
      method: 'PUT',
      headers: { Authorization: `Basic ${Buffer.from(`:${VALID_PAT}`, 'utf8').toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName: 'The Owner', vote }),
    }
  )
  assert.equal(res.status, 200)
}

async function abandonPullRequest(adoBaseUrl, pullRequestId) {
  const res = await fetch(
    `${adoBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Basic ${Buffer.from(`:${VALID_PAT}`, 'utf8').toString('base64')}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'abandoned' }),
    }
  )
  assert.equal(res.status, 200)
}

function withRemoteInstance(fn, serverOverrides = {}) {
  return withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\n` },
      ...serverOverrides,
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

function withRunningBrowser(fn) {
  return (async () => {
    const browser = await launchBrowser()
    try {
      await fn(browser)
    } finally {
      await browser.close()
    }
  })()
}

test('the Request approval panel is never shown for a local instance', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })

    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      await withRunningBrowser(async (browser) => {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/instance/my-initiative`)
        await page.waitForSelector('#modules', { timeout: 10_000 })

        assert.equal(await page.locator('.signoff-section').count(), 0)
        // The Stage advancement panel (an unrelated, local-instance-only
        // panel) is still there — confirming the page genuinely loaded
        // this instance's real stage screen, rather than the request-
        // approval panel simply being missing because nothing rendered.
        await assert.doesNotReject(page.locator('.advance-stage-panel').waitFor({ timeout: 5_000 }))

        assert.deepEqual(pageErrors, [])
      })
    })
  })
})

test('the Request approval panel blocks on a failing gate for a Workspace-backed instance, without opening a Pull Request', async () => {
  await withRemoteInstance(async ({ adoBaseUrl, instancesDir }) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
    // Work has begun on the branch, but no module content was ever saved to it — the gate can't pass.
    await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)

    await withRunningServer(
      { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
      async (base) => {
        await withRunningBrowser(async (browser) => {
          const page = await browser.newPage()
          page.setDefaultTimeout(DEFAULT_TIMEOUT)
          const pageErrors = []
          page.on('pageerror', (err) => pageErrors.push(err.message))
          page.on('console', (msg) => {
            if (msg.type() === 'error') pageErrors.push(msg.text())
          })

          await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

          await page.goto(`${base}/instance/${SLUG}`)
          await page.waitForSelector('.signoff-section', { timeout: 10_000 })
          const panel = page.locator('.signoff-section')

          await panel.getByRole('button', { name: 'Request Sign-off' }).click()
          await assert.doesNotReject(panel.locator('text=FAIL').waitFor({ timeout: 10_000 }))
          assert.equal(await page.locator('.modal[aria-label="Confirm request sign-off"]').count(), 0)

          assert.deepEqual(pageErrors, [])
        })
      }
    )
  })
})

test('declining the confirmation opens no Pull Request', async () => {
  await withRemoteInstance(async ({ adoBaseUrl, instancesDir }) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    await fillShapeStage(azureDevOps, branch)

    await withRunningServer(
      { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
      async (base) => {
        await withRunningBrowser(async (browser) => {
          const page = await browser.newPage()
          page.setDefaultTimeout(DEFAULT_TIMEOUT)
          const pageErrors = []
          page.on('pageerror', (err) => pageErrors.push(err.message))
          page.on('console', (msg) => {
            if (msg.type() === 'error') pageErrors.push(msg.text())
          })

          await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

          await page.goto(`${base}/instance/${SLUG}`)
          await page.waitForSelector('.signoff-section', { timeout: 10_000 })
          const panel = page.locator('.signoff-section')

          await panel.getByRole('button', { name: 'Request Sign-off' }).click()
          const modal = page.locator('.modal[aria-label="Confirm request sign-off"]')
          await modal.waitFor({ state: 'visible', timeout: 10_000 })
          await modal.getByRole('button', { name: 'Decline' }).click()
          await assert.doesNotReject(panel.locator('text=Declined — no Pull Request opened.').waitFor({ timeout: 5_000 }))
          await assert.doesNotReject(modal.waitFor({ state: 'hidden', timeout: 5_000 }))

          assert.deepEqual(pageErrors, [])
        })
      }
    )
  })
})

test('confirming opens a Pull Request, and the panel reflects it — including surviving a page reload', async () => {
  await withRemoteInstance(async ({ adoBaseUrl, instancesDir }) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    await fillShapeStage(azureDevOps, branch)

    await withRunningServer(
      { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
      async (base) => {
        await withRunningBrowser(async (browser) => {
          const page = await browser.newPage()
          page.setDefaultTimeout(DEFAULT_TIMEOUT)
          const pageErrors = []
          page.on('pageerror', (err) => pageErrors.push(err.message))
          page.on('console', (msg) => {
            if (msg.type() === 'error') pageErrors.push(msg.text())
          })

          await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

          await page.goto(`${base}/instance/${SLUG}`)
          await page.waitForSelector('.signoff-section', { timeout: 10_000 })
          const panel = page.locator('.signoff-section')

          await panel.getByRole('button', { name: 'Request Sign-off' }).click()
          const modal = page.locator('.modal[aria-label="Confirm request sign-off"]')
          await modal.waitFor({ state: 'visible', timeout: 10_000 })
          await modal.getByRole('button', { name: 'Confirm & request sign-off' }).click()

          await assert.doesNotReject(panel.locator('text=/Pull Request #\\d+ is open/').waitFor({ timeout: 10_000 }))
          // The button itself is replaced once a Pull Request is open — no
          // way to accidentally request a second one from this panel.
          assert.equal(await panel.getByRole('button', { name: 'Request Sign-off' }).count(), 0)

          // Surviving a full reload proves this is read back off the
          // instance's own persisted `pullRequests` field (#124), not just
          // transient in-page state from the action's own response.
          await page.reload()
          await page.waitForSelector('.signoff-section', { timeout: 10_000 })
          await assert.doesNotReject(
            page.locator('.signoff-section', { hasText: /Pull Request #\d+ is open/ }).waitFor({ timeout: 10_000 })
          )

          assert.deepEqual(pageErrors, [])
        })
      }
    )
  })
})

test('reloading reflects a Pull Request abandoned outside gantry', async () => {
  await withRemoteInstance(async ({ adoBaseUrl, instancesDir }) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    await fillShapeStage(azureDevOps, branch)

    await withRunningServer(
      { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
      async (base) => {
        await withRunningBrowser(async (browser) => {
          const page = await browser.newPage()
          const pageErrors = []
          page.on('pageerror', (err) => pageErrors.push(err.message))
          page.on('console', (msg) => {
            if (msg.type() === 'error') pageErrors.push(msg.text())
          })

          await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)
          await page.goto(`${base}/instance/${SLUG}`)
          const panel = page.locator('.signoff-section')
          await panel.waitFor({ timeout: 10_000 })

          await panel.getByRole('button', { name: 'Request Sign-off' }).click()
          const modal = page.locator('.modal[aria-label="Confirm request sign-off"]')
          await modal.getByRole('button', { name: 'Confirm & request sign-off' }).click()
          await assert.doesNotReject(panel.locator('text=/Pull Request #\\d+ is open/').waitFor({ timeout: 10_000 }))
          const prId = Number((await panel.locator('text=/Pull Request #(\\d+)/').first().textContent()).match(/#(\d+)/)[1])

          await abandonPullRequest(adoBaseUrl, prId)
          await page.reload()
          await panel.waitFor({ timeout: 10_000 })

          assert.equal(await panel.getByText(/Pull Request #\d+ is open/).count(), 0)
          await assert.doesNotReject(
            panel.getByText(/Pull Request #\d+ was abandoned \(closed without merging\) for stage/).waitFor({ timeout: 10_000 })
          )
          assert.equal(await panel.getByText('Not assigned (pending)').count(), 0)
          // #213: the sign-off section no longer carries its own "Check
          // status" button — the card's single top-of-card control (inside
          // #work-item-detail-card's .panel-header) covers it instead.
          assert.equal(await panel.getByRole('button', { name: 'Check status' }).count(), 0)
          assert.equal(
            await page.locator('#work-item-detail-card .panel-header').getByRole('button', { name: 'Check status' }).count(),
            1
          )
          assert.deepEqual(pageErrors, [])
        })
      }
    )
  })
})

test('Check status reports pending, then rejection, then approval — merging and advancing on approval (#125)', async () => {
  await withRemoteInstance(async ({ adoBaseUrl, instancesDir }) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    await fillShapeStage(azureDevOps, branch)

    await withRunningServer(
      { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
      async (base) => {
        await withRunningBrowser(async (browser) => {
          const page = await browser.newPage()
          page.setDefaultTimeout(DEFAULT_TIMEOUT)
          const pageErrors = []
          page.on('pageerror', (err) => pageErrors.push(err.message))
          page.on('console', (msg) => {
            if (msg.type() === 'error') pageErrors.push(msg.text())
          })

          await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

          await page.goto(`${base}/instance/${SLUG}`)
          const card = page.locator('#work-item-detail-card')
          const panel = page.locator('.signoff-section')
          await panel.waitFor({ timeout: 10_000 })

          // Open the Pull Request first.
          await panel.getByRole('button', { name: 'Request Sign-off' }).click()
          const modal = page.locator('.modal[aria-label="Confirm request sign-off"]')
          await modal.waitFor({ state: 'visible', timeout: 10_000 })
          await modal.getByRole('button', { name: 'Confirm & request sign-off' }).click()
          await assert.doesNotReject(panel.locator('text=/Pull Request #\\d+ is open/').waitFor({ timeout: 10_000 }))
          const prId = Number((await panel.locator('text=/Pull Request #(\\d+)/').first().textContent()).match(/#(\d+)/)[1])

          // #213: "Check status" is now the one control at the top of the
          // whole Work item details card, not a per-section button — the
          // sign-off section itself no longer offers its own.
          assert.equal(await panel.getByRole('button', { name: 'Check status' }).count(), 0)
          const checkButton = card.locator('.panel-header').getByRole('button', { name: 'Check status' })
          assert.equal(await checkButton.count(), 1)

          // No decision yet → explicitly pending. The result lands in the
          // card's own status line (below the reviews/sign-off sub-card),
          // not inside the sign-off section.
          await castVote(adoBaseUrl, prId, 0)
          await checkButton.click()
          await assert.doesNotReject(card.locator('text=Still pending — the Owner hasn\'t reviewed').waitFor({ timeout: 10_000 }))

          // An explicit rejection reads as a decision, not as silence.
          await castVote(adoBaseUrl, prId, -10)
          await checkButton.click()
          await assert.doesNotReject(card.locator('text=Rejected — the Owner voted to reject').waitFor({ timeout: 10_000 }))

          // Approval auto-merges and advances; the screen follows the
          // instance to its new current stage.
          await castVote(adoBaseUrl, prId, 10)
          await checkButton.click()
          await assert.doesNotReject(page.locator('text=/Approved — Pull Request #\\d+ merged; stage advanced to/').waitFor({ timeout: 10_000 }))
          await assert.doesNotReject(
            page.locator('#stage-line', { hasText: 'High-level Design' }).waitFor({ timeout: 10_000 })
          )
          // The merged stage's Pull Request is gone from the panel — the
          // screen now shows the next stage, which hasn't requested
          // approval yet, so "Request Sign-off" is offered afresh.
          await assert.doesNotReject(
            page.locator('.signoff-section').getByRole('button', { name: 'Request Sign-off' }).waitFor({ timeout: 10_000 })
          )

          assert.deepEqual(pageErrors, [])
        })
      }
    )
  })
})

test('a post-approval commit changes the panel to Request approval again, and resetting restores Check status', async () => {
  await withRemoteInstance(async ({ adoBaseUrl, instancesDir }) => {
    const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
    const branch = await resolveStageBranch(azureDevOps, definition, SLUG, SHAPE.id)
    await fillShapeStage(azureDevOps, branch)

    await withRunningServer({ instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
      await withRunningBrowser(async (browser) => {
        const page = await browser.newPage()
        await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)
        await page.goto(`${base}/instance/${SLUG}`)

        // #213: "Check status" lives once, at the top of the Work item
        // details card, not inside the sign-off section itself.
        const card = page.locator('#work-item-detail-card')
        const checkButton = card.locator('.panel-header').getByRole('button', { name: 'Check status' })
        const panel = page.locator('.signoff-section')
        // #225: "Show commit history" now lives in the card's `.panel-header`,
        // immediately left of "Check status" — the modal it opens is unchanged.
        const commitHistorySection = card.locator('.panel-header')
        await panel.getByRole('button', { name: 'Request Sign-off' }).click()
        // The confirm modal is a card-level overlay (not nested inside
        // `.signoff-section` itself), same as every other confirm dialog on
        // this card — scope to the page, not the section.
        await page.locator('.modal[aria-label="Confirm request sign-off"]').getByRole('button', { name: 'Confirm & request sign-off' }).click()
        await assert.doesNotReject(panel.locator('text=/Pull Request #\\d+ is open/').waitFor({ timeout: 10_000 }))
        const prId = Number((await panel.locator('text=/Pull Request #(\\d+)/').first().textContent()).match(/#(\d+)/)[1])

        await castVote(adoBaseUrl, prId, 10)
        await new Promise((resolve) => setTimeout(resolve, 10))
        await createAzureDevOpsClient(azureDevOps).writeFile(
          `gantry-workspace/${SLUG}/modules/background.md`,
          `${readFileSync(join('instances', 'examples', 'modules', 'background.md'), 'utf8')}\nPost-approval browser edit.\n`,
          { branch, message: 'Post-approval browser edit' },
        )
        for (let i = 1; i <= 40; i += 1) {
          await createAzureDevOpsClient(azureDevOps).writeFile(
            `gantry-workspace/${SLUG}/modules/background.md`,
            `${readFileSync(join('instances', 'examples', 'modules', 'background.md'), 'utf8')}\nPost-approval browser edit ${i}.\n`,
            { branch, message: `Post-approval browser edit ${i}` },
          )
        }

        await checkButton.click()
        await panel.getByRole('button', { name: 'Request Sign-off again' }).waitFor({ timeout: 10_000 })
        assert.equal(await panel.locator('.request-approval-commits').count(), 0)

        // WI216: inline commit-history summary removed — history only in dialog.
        // WI225: the only commit-history control is the header button.
        await commitHistorySection.waitFor({ timeout: 10_000 })
        assert.equal(await commitHistorySection.locator('.commit-history-summary').count(), 0)
        assert.equal(await commitHistorySection.getByRole('button', { name: 'Show commit history' }).count(), 1)
        assert.equal(await commitHistorySection.locator('.request-approval-commits').count(), 0)

        // WI226: a "Show files" link sits immediately left of "Show commit
        // history", deep-linking to this instance's folder in the repo.
        const showFiles = commitHistorySection.getByRole('link', { name: 'Show files' })
        assert.equal(await showFiles.count(), 1)
        assert.equal(await showFiles.getAttribute('target'), '_blank')
        assert.match(await showFiles.getAttribute('href'), /_git\/[^?]+\?path=\/gantry-workspace\/remote-initiative$/)

        await commitHistorySection.getByRole('button', { name: 'Show commit history' }).click()
        const historyModal = page.locator('.modal[aria-label="Commit history"]')
        await historyModal.waitFor({ state: 'visible', timeout: 5_000 })
        await historyModal.locator('.request-approval-commits')
          .getByText('Post-approval browser edit', { exact: true }).first()
          .waitFor({ state: 'visible', timeout: 15_000 })
        assert.equal(await historyModal.locator('.request-approval-commits').getByText('Post-approval browser edit', { exact: true }).count(), 1)
        const scrollState = await historyModal.evaluate((element) => ({
          scrollable: element.scrollHeight > element.clientHeight,
          height: element.clientHeight,
          viewportHeight: window.innerHeight,
        }))
        assert.equal(scrollState.scrollable, true)
        assert.ok(scrollState.height <= scrollState.viewportHeight * 0.85 + 2)

        await page.keyboard.press('Escape')
        await historyModal.waitFor({ state: 'hidden', timeout: 5_000 })

        await commitHistorySection.getByRole('button', { name: 'Show commit history' }).click()
        await historyModal.waitFor({ state: 'visible', timeout: 5_000 })
        await page.locator('.modal-backdrop').last().click({ position: { x: 5, y: 5 } })
        await historyModal.waitFor({ state: 'hidden', timeout: 5_000 })

        await panel.getByRole('button', { name: 'Request Sign-off again' }).click()
        await assert.doesNotReject(panel.locator('text=Approval withdrawn from Pull Request').waitFor({ timeout: 10_000 }))
      })
    })
  })
})

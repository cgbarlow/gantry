import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { loadDefinition } from '../lib/definition.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { resolveStageBranch } from '../lib/stageBranch.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, basicAuthHeader, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// #275, ADR-0069 — what an architect sees when a later stage's approval also re-approves an earlier one. SOAP (`shape`)
// is approved by its own reviewer through the real routes against a fake Azure DevOps, the Instance is at HLD
// (`hld-define`), and HLD fills its gate and rewords a Field SOAP prints. Then, in a real browser: Request Sign-off names
// what it also re-approves and who must approve, Check status waits for the second reviewer, and after the merge the SOAP
// stage shows the re-approval in its history and its flag is gone. Nothing is mocked in the browser.
//
// Set CAPTURE_USER_GUIDE_SCREENSHOT=1 to also write the user guide's picture (web/user-guide-images/
// changed-since-approval.png) from this same test remote workspace.

const SLUG = 'reapproval-ui'
const definition = loadDefinition('design', { version: 2 })
const HLD = definition.stages.find((s) => s.id === 'hld-define')
const headers = { Authorization: basicAuthHeader(VALID_PAT) }
const SHAPE_MODULES = ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']

function backgroundWithProblem(text, problem) {
  const marker = '## Problem statement\n'
  const start = text.indexOf(marker) + marker.length
  const next = text.indexOf('\n## ', start)
  return `${text.slice(0, start)}\n${problem}\n${text.slice(next)}`
}

async function vote(adoBaseUrl, pullRequestId, reviewerId, displayName, value) {
  const res = await fetch(`${adoBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}/reviewers/${reviewerId}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName, vote: value }),
  })
  assert.equal(res.status, 200)
}

// Approves SOAP as `SOAP Owner`, merges it, tidies the merged branch away as a real repository would, and fills HLD.
async function approveSoapAndDraftHld(base, adoBaseUrl) {
  const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
  const client = createAzureDevOpsClient(azureDevOps)
  const branch = await resolveStageBranch(azureDevOps, definition, SLUG, 'shape')
  for (const moduleId of SHAPE_MODULES) {
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, exampleModuleText(moduleId), { branch })
  }
  await client.writeFile(`gantry-workspace/${SLUG}/out/Reapproval Ui - Solution on a Page.docx`, 'rendered soap', { branch })

  const opened = await (await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers })).json()
  await vote(adoBaseUrl, opened.pullRequestId, 'soap-owner', 'SOAP Owner', 10)
  const approved = await (await fetch(`${base}/api/instance/check-status?slug=${SLUG}`, { method: 'POST', headers })).json()
  assert.equal(approved.merged, true)

  const shapeBranch = `gantry-workspace/${SLUG}/shape`
  await fetch(`${adoBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/${'gi' + 't'}/repositories/${REPOSITORY}/refs?api-version=7.1`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ name: `refs/heads/${shapeBranch}`, oldObjectId: await client.getBranchObjectId(shapeBranch), newObjectId: '0'.repeat(40) }]),
  })

  const hldBranch = await resolveStageBranch(azureDevOps, definition, SLUG, 'hld-define')
  for (const moduleId of HLD.modules) {
    if (SHAPE_MODULES.includes(moduleId)) continue
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, exampleModuleText(moduleId), { branch: hldBranch })
  }
  await client.writeFile(
    `gantry-workspace/${SLUG}/modules/background.md`,
    backgroundWithProblem(exampleModuleText('background'), 'Reworded during the HLD review.'),
    { branch: hldBranch }
  )
  await client.writeFile(`gantry-workspace/${SLUG}/out/Reapproval Ui - High Level Design.docx`, 'rendered hld', { branch: hldBranch })
}

test('a sign-off request names the earlier stage it also re-approves, waits for its reviewer, and the earlier stage shows the re-approval afterwards', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\ndefinitionVersion: 2\nrequiredReviewer: Test User\n` },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-reapproval-'))
      try {
        registerInstance(SLUG, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true, allowedAzureDevOpsBaseUrls: [adoBaseUrl] }, async (base) => {
          await approveSoapAndDraftHld(base, adoBaseUrl)

          const browser = await launchBrowser()
          try {
            const page = await browser.newPage()
            page.setDefaultTimeout(DEFAULT_TIMEOUT)
            await page.setViewportSize({ width: 1280, height: 900 })
            const pageErrors = []
            page.on('pageerror', (err) => pageErrors.push(err.message))
            page.on('console', (msg) => {
              if (msg.type() === 'error') pageErrors.push(msg.text())
            })
            await page.addInitScript((pat) => {
              localStorage.setItem('gantry:ado-pat', pat)
              localStorage.setItem('gantry:advancedMode', 'true')
            }, VALID_PAT)

            await page.goto(`${base}/instance/${SLUG}`)
            await page.waitForSelector('[data-testid="changed-since-approval-notice"]', { timeout: 30_000 })
            await page.waitForSelector('.signoff-section', { timeout: 30_000 })
            assert.equal(await page.locator('#stage-nav button', { hasText: 'SOAP' }).getAttribute('data-changed-since-approval'), 'true')

            // Request Sign-off, confirm.
            await page.locator('.signoff-section').getByRole('button', { name: 'Request Sign-off' }).click()
            await page.getByRole('button', { name: 'Confirm & request sign-off' }).click()
            await page.waitForSelector('[data-testid="also-reapproving"]', { timeout: 30_000 })

            const status = await page.locator('.signoff-section .save-status').textContent()
            assert.match(status, /opened/)
            assert.match(status, /It also re-approves SOAP \(\d+ Fields?\), so SOAP Owner must approve too\./)
            assert.match(await page.locator('[data-testid="also-reapproving"]').textContent(), /Needs SOAP Owner to approve .*SOAP: \d+ Fields?/)
            const pullRequestId = Number((await page.locator('.signoff-pr-ref').textContent()).match(/Pull Request #(\d+)/)[1])

            if (process.env.CAPTURE_USER_GUIDE_SCREENSHOT) {
              // The flagged stage tab at the top and the Request approval panel below it, as one picture.
              mkdirSync('web/user-guide-images', { recursive: true })
              const panel = await page.locator('.review-signoff-card').boundingBox()
              const nav = await page.locator('#stage-nav').boundingBox()
              await page.screenshot({
                path: 'web/user-guide-images/changed-since-approval.png',
                fullPage: true,
                clip: { x: 0, y: Math.max(0, nav.y - 70), width: 1280, height: panel.y + panel.height - nav.y + 90 },
              })
            }

            // HLD's own reviewer approves; SOAP's has not: Check status holds the Pull Request.
            await vote(adoBaseUrl, pullRequestId, 'fake-identity-id-001', 'Test User', 10)
            await page.locator('#work-item-detail-card').getByRole('button', { name: 'Check status' }).click()
            await page.waitForFunction(() => /Still waiting/.test(document.body.textContent), null, { timeout: 30_000 })
            const waiting = await page.locator('#work-item-detail-card .save-status', { hasText: 'Still waiting' }).first().textContent()
            assert.match(waiting, new RegExp(`Still waiting — Pull Request #${pullRequestId} needs SOAP Owner, whose approval re-approves SOAP`))

            // SOAP's reviewer approves: it merges.
            await vote(adoBaseUrl, pullRequestId, 'soap-owner', 'SOAP Owner', 10)
            await page.locator('#work-item-detail-card').getByRole('button', { name: 'Check status' }).click()
            await page.waitForFunction(() => /merged; stage advanced/.test(document.body.textContent), null, { timeout: 30_000 })

            // SOAP's own tab: no flag any more, and the re-approval is in its history.
            await page.reload()
            await page.waitForSelector('#stage-nav button', { timeout: 30_000 })
            assert.equal(await page.locator('#stage-nav [data-changed-since-approval]').count(), 0, 'no stage is flagged once the re-approval merged')
            await page.locator('#stage-nav button', { hasText: 'SOAP' }).click()
            await page.waitForSelector('[data-testid="reapproval-history"]', { timeout: 30_000 })
            const history = await page.locator('[data-testid="reapproval-entry"]').allTextContents()
            assert.equal(history.length, 1)
            assert.match(history[0], new RegExp(`^Re-approved \\d{4}-\\d{2}-\\d{2} by ${HLD.title} \\(Pull Request #${pullRequestId}\\): \\d+ Fields?\\. Approved by SOAP Owner\\.$`))

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
})

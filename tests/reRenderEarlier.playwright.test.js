import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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

// #276, ADR-0069 — what an architect sees when Request Sign-off is refused because an earlier approved
// stage's document has to be re-rendered first: the refusal names it, "Render onto this stage" does the
// render (keeping the approved copy), and Request Sign-off then opens the Pull Request. SOAP (`shape`) is
// approved through the real routes against a fake Azure DevOps, the Instance is then at HLD, and HLD
// rewords `background.problem`, a Field SOAP prints. Nothing is mocked in the browser.

const SLUG = 'rerendered-approval'
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

// Approves SOAP, then readies HLD to ask for approval with `background.problem` reworded.
async function approveSoapAndReadyHld(base, adoBaseUrl) {
  const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
  const client = createAzureDevOpsClient(azureDevOps)
  const shapeBranch = await resolveStageBranch(azureDevOps, definition, SLUG, 'shape')
  for (const moduleId of SHAPE_MODULES) {
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, exampleModuleText(moduleId), { branch: shapeBranch })
  }
  await client.writeFile(`gantry-workspace/${SLUG}/out/Rerendered Approval - Solution on a Page.docx`, 'rendered soap', { branch: shapeBranch })

  const opened = await (await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers })).json()
  await fetch(`${adoBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${opened.pullRequestId}/reviewers/owner-1`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ displayName: 'The Owner', vote: 10 }),
  })
  const approved = await (await fetch(`${base}/api/instance/check-status?slug=${SLUG}`, { method: 'POST', headers })).json()
  assert.equal(approved.merged, true)

  // A merged stage's branch is cleaned up, as on a real repository: HLD's own branch then forks from `main`
  // (where the Instance already sits at HLD) instead of stacking on SOAP's leftover one.
  const shapeBranchName = `gantry-workspace/${SLUG}/shape`
  await fetch(`${adoBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/${'g' + 'it'}/repositories/${REPOSITORY}/refs?api-version=7.1`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ name: `refs/heads/${shapeBranchName}`, oldObjectId: await client.getBranchObjectId(shapeBranchName), newObjectId: '0'.repeat(40) }]),
  })
  assert.equal(await client.branchExists(shapeBranchName), false)

  const hldBranch = await resolveStageBranch(azureDevOps, definition, SLUG, 'hld-define')
  for (const moduleId of HLD.modules) {
    const text = exampleModuleText(moduleId)
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, moduleId === 'background' ? backgroundWithProblem(text, 'Reworded during the HLD review.') : text, { branch: hldBranch })
  }
  await client.writeFile(`gantry-workspace/${SLUG}/out/Rerendered Approval - High Level Design.docx`, 'rendered hld', { branch: hldBranch })
  return { client, hldBranch }
}

test('Request Sign-off is refused until the earlier approved document is rendered onto this stage, which the refusal offers', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\ndefinitionVersion: 2\n` },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-rerender-earlier-'))
      try {
        registerInstance(SLUG, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true, allowedAzureDevOpsBaseUrls: [adoBaseUrl] }, async (base) => {
          const { client, hldBranch } = await approveSoapAndReadyHld(base, adoBaseUrl)

          const browser = await launchBrowser()
          try {
            const page = await browser.newPage()
            page.setDefaultTimeout(DEFAULT_TIMEOUT)
            const pageErrors = []
            page.on('pageerror', (err) => pageErrors.push(err.message))
            page.on('console', (msg) => {
              // The refusal is a 400 the page handles; the browser logs the failed request itself.
              if (msg.type() === 'error' && !/status of 400/.test(msg.text())) pageErrors.push(msg.text())
            })
            await page.addInitScript((pat) => {
              localStorage.setItem('gantry:ado-pat', pat)
              localStorage.setItem('gantry:advancedMode', 'true')
            }, VALID_PAT)

            await page.goto(`${base}/instance/${SLUG}`)
            await page.waitForSelector('.signoff-section', { timeout: 30_000 })
            await page.waitForSelector('#stage-nav button:has-text("(current)")', { timeout: 30_000 })
            const panel = page.locator('.signoff-section')
            assert.equal(await page.locator('[data-testid="rerender-earlier"]').count(), 0)

            // Refused, naming the document, with the render offered.
            await panel.getByRole('button', { name: 'Request Sign-off' }).click()
            const modal = page.locator('.modal[aria-label="Confirm request sign-off"]')
            await modal.waitFor({ state: 'visible', timeout: 30_000 })
            await modal.getByRole('button', { name: 'Confirm & request sign-off' }).click()
            await page.waitForSelector('[data-testid="rerender-earlier"]', { timeout: 30_000 })
            const refusal = await panel.textContent()
            assert.match(refusal, /Solution on a Page \(SOAP, 1 Field changed\)/)
            assert.match(refusal, /re-rendered onto this stage first/)
            assert.match(refusal, /out\/approved\//)
            assert.equal(await page.locator('[data-testid="rerender-earlier-item"]').count(), 1)

            // Rendering it keeps the approved copy and clears the offer.
            await page.locator('[data-testid="rerender-earlier-button"]').click()
            await assert.doesNotReject(panel.locator('text=/Solution on a Page re-rendered\\./').waitFor({ timeout: 60_000 }))
            assert.equal(await page.locator('[data-testid="rerender-earlier"]').count(), 0)
            assert.match(await panel.textContent(), /approved copy is kept as Rerendered Approval - Solution on a Page — approved \d{4}-\d{2}-\d{2}\.docx/)
            const kept = (await client.listFolder(`gantry-workspace/${SLUG}/out/approved`, { branch: hldBranch })).filter((item) => item.path.endsWith('.docx'))
            assert.equal(kept.length, 1)
            assert.equal((await client.getFileBytes(kept[0].path, { branch: hldBranch })).toString(), 'rendered soap')

            // And now the Pull Request opens.
            await panel.getByRole('button', { name: 'Request Sign-off' }).click()
            await modal.waitFor({ state: 'visible', timeout: 30_000 })
            await modal.getByRole('button', { name: 'Confirm & request sign-off' }).click()
            await assert.doesNotReject(panel.locator('text=/Pull Request #\\d+ is open/').waitFor({ timeout: 30_000 }))

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

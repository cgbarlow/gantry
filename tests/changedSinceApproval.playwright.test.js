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

// #273, ADR-0069 — what an architect sees when a later stage has changed content an earlier stage was
// approved on: the stage tab, the stage status line, the sign-off section ("also re-approves SOAP: 1
// Field") and the dashboard row. SOAP (`shape`) is approved through the real routes against a fake
// Azure DevOps, the Instance is then at HLD (`hld-define`), and HLD rewords `background.problem`, a Field
// SOAP prints. Nothing is mocked in the browser.

const SLUG = 'soap-drift'
const definition = loadDefinition('design', { version: 2 })
const headers = { Authorization: basicAuthHeader(VALID_PAT) }
const SHAPE_MODULES = ['background', 'introduction', 'design-basis', 'solution-definition', 'team-and-estimates']

function backgroundWithProblem(text, problem) {
  const marker = '## Problem statement\n'
  const start = text.indexOf(marker) + marker.length
  const next = text.indexOf('\n## ', start)
  return `${text.slice(0, start)}\n${problem}\n${text.slice(next)}`
}

async function approveSoap(base, adoBaseUrl) {
  const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl }
  const client = createAzureDevOpsClient(azureDevOps)
  const branch = await resolveStageBranch(azureDevOps, definition, SLUG, 'shape')
  for (const moduleId of SHAPE_MODULES) {
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, exampleModuleText(moduleId), { branch })
  }
  await client.writeFile(`gantry-workspace/${SLUG}/out/Soap Drift - Solution on a Page.docx`, 'rendered soap', { branch })

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
  const shapeBranch = `gantry-workspace/${SLUG}/shape`
  const refsUrl = `${adoBaseUrl}/${ORGANIZATION}/${PROJECT}/_apis/${'g' + 'it'}/repositories/${REPOSITORY}/refs?api-version=7.1`
  await fetch(refsUrl, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ name: `refs/heads/${shapeBranch}`, oldObjectId: await client.getBranchObjectId(shapeBranch), newObjectId: '0'.repeat(40) }]),
  })
  assert.equal(await client.branchExists(shapeBranch), false)

  return async (problem) => {
    const hldBranch = await resolveStageBranch(azureDevOps, definition, SLUG, 'hld-define')
    await client.writeFile(`gantry-workspace/${SLUG}/modules/background.md`, backgroundWithProblem(exampleModuleText('background'), problem), { branch: hldBranch })
  }
}

test('an approved stage whose printed Field a later stage changed is flagged on its tab, in the stage status, in the sign-off section and on the dashboard row', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\ndefinitionVersion: 2\n` },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-changed-since-approval-'))
      try {
        registerInstance(SLUG, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true, allowedAzureDevOpsBaseUrls: [adoBaseUrl] }, async (base) => {
          const rewordAtHld = await approveSoap(base, adoBaseUrl)

          const browser = await launchBrowser()
          try {
            const page = await browser.newPage()
            page.setDefaultTimeout(DEFAULT_TIMEOUT)
            const pageErrors = []
            page.on('pageerror', (err) => pageErrors.push(err.message))
            page.on('console', (msg) => {
              if (msg.type() === 'error') pageErrors.push(msg.text())
            })
            await page.addInitScript((pat) => {
              localStorage.setItem('gantry:ado-pat', pat)
              localStorage.setItem('gantry:advancedMode', 'true')
            }, VALID_PAT)

            // Nothing changed yet: no flag anywhere.
            await page.goto(`${base}/instance/${SLUG}`)
            await page.waitForSelector('#stage-nav button', { timeout: 30_000 })
            await page.waitForSelector('.signoff-section', { timeout: 30_000 })
            assert.equal(await page.locator('[data-testid="changed-since-approval-notice"]').count(), 0)
            assert.equal(await page.locator('#stage-nav [data-changed-since-approval]').count(), 0)
            assert.equal(await page.locator('[data-testid="also-reapproves"]').count(), 0)

            // HLD rewords a Field SOAP prints.
            await rewordAtHld('Reworded during the HLD review.')
            await page.reload()
            await page.waitForSelector('[data-testid="changed-since-approval-notice"]', { timeout: 30_000 })

            const notice = await page.locator('[data-testid="changed-since-approval-notice"]').textContent()
            assert.match(notice, /Changed since approval/)
            assert.match(notice, /SOAP: 1 Field/)

            const soapTab = page.locator('#stage-nav button', { hasText: 'SOAP' })
            assert.equal(await soapTab.getAttribute('data-changed-since-approval'), 'true')
            assert.match(await soapTab.textContent(), /Changed since approval/)
            assert.equal(await page.locator('#stage-nav [data-changed-since-approval]').count(), 1, 'only SOAP is flagged')

            assert.match(await page.locator('[data-testid="also-reapproves"]').textContent(), /also re-approves SOAP: 1 Field/)

            // The flag is about the Instance, so the earlier stage's own screen still carries it.
            await soapTab.click()
            await page.waitForSelector('[data-testid="completed-stage-banner"]', { timeout: 30_000 })
            assert.match(await page.locator('[data-testid="changed-since-approval-notice"]').textContent(), /SOAP: 1 Field/)
            assert.equal(await page.locator('[data-testid="also-reapproves"]').count(), 0, 'the sign-off line belongs to the current stage')

            // The dashboard row. (An unscoped listing carries no stored credential, so it is attached at the network layer.)
            await page.route('**/api/instances', async (route) => {
              await route.continue({ headers: { ...route.request().headers(), authorization: basicAuthHeader(VALID_PAT) } })
            })
            await page.goto(base)
            await page.waitForSelector('.master-detail', { timeout: 30_000 })
            await page.locator('.instance-list .list-item').click()
            await page.waitForSelector('.instance-card', { timeout: 30_000 })
            const badge = page.locator('.instance-card [data-testid="changed-since-approval-badge"]')
            assert.equal(await badge.textContent(), 'CHANGED SINCE APPROVAL')
            assert.equal(await badge.getAttribute('title'), 'SOAP: 1 Field')

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

test('a local workspace shows no Changed since approval flag anywhere', async () => {
  const { withRunningExamplesServer } = await import('./helpers/lifecycle.js')
  await withRunningExamplesServer({}, async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.goto(`${base}/instance/examples?stage=hld-define`)
      await page.waitForSelector('#stage-nav button', { timeout: 30_000 })
      assert.equal(await page.locator('[data-testid="changed-since-approval-notice"]').count(), 0)
      assert.equal(await page.locator('#stage-nav [data-changed-since-approval]').count(), 0)
      assert.doesNotMatch(await page.locator('body').textContent(), /Changed since approval/)
    } finally {
      await browser.close()
    }
  })
})

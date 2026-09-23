import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'

// #142: a completed Stage's own editor screen — SOAP (`shape`), browsed after the instance has
// advanced to HLD (`hld-define`), with `shape`'s own branch already merged and cleaned up (so nothing
// but `main` has ever held its approved content, the exact state the issue's own retriage hazard
// describes — a save reaching resolveStageBranch here would otherwise recreate that branch from
// scratch). `hld-define` has since edited the Module the two Stages share.

function backgroundModule(problemText) {
  return `---\nmodule: background\nstatus: draft\nowner: \n---\n\n# Background and context\n\n## Problem statement\n\n${problemText}\n`
}

test('a completed Stage\'s screen labels itself, names a sibling Stage with unmerged shared changes, and goes read-only (Re-open is the way back in)', async () => {
  const slug = 'hire'
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: {
        [`/gantry-workspace/${slug}/instance.yaml`]: `definition: design\nslug: ${slug}\nstage: hld-define\n`,
        [`/gantry-workspace/${slug}/modules/background.md`]: backgroundModule('Approved baseline problem statement.'),
      },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-completed-stage-e2e-'))
      try {
        registerInstance(slug, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
        // hld-define (the real current Stage) has its own branch, with unmerged edits to `background`
        // — a Module `shape` also mounts.
        await client.createBranch(`gantry-workspace/${slug}/hld-define`)
        await client.writeFile(`/gantry-workspace/${slug}/modules/background.md`, backgroundModule('Reworded during HLD review.'), {
          branch: `gantry-workspace/${slug}/hld-define`,
        })
        // `shape` itself has no branch at all — already merged and cleaned up.
        assert.equal(await client.branchExists(`gantry-workspace/${slug}/shape`), false)

        await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true, allowedAzureDevOpsBaseUrls: [adoBaseUrl] }, async (gantryBase) => {
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
            }, VALID_PAT)

            await page.goto(`${gantryBase}/instance/${slug}`)
            await page.waitForSelector('.module', { timeout: 10_000 })

            // No completed-stage banner while viewing the actual current Stage.
            assert.equal(await page.locator('[data-testid="completed-stage-banner"]').count(), 0)
            await page.getByRole('button', { name: 'Save', exact: true }).waitFor({ timeout: 5_000 })

            // Free-browse to the completed `shape` Stage (title "SOAP").
            await page.locator('#stage-nav button', { hasText: 'SOAP' }).click()
            await page.waitForSelector('.module', { timeout: 10_000 })

            const banner = page.locator('[data-testid="completed-stage-banner"]')
            await banner.waitFor({ state: 'visible', timeout: 10_000 })
            const bannerText = await banner.textContent()
            assert.match(bannerText, /complete/)
            assert.match(bannerText, /approved version on main/)
            assert.match(bannerText, /High-level Design/, 'names the sibling Stage with the unmerged shared change')

            // Re-open is the way back in; the fields themselves are read-only.
            await page.locator('[data-testid="reopen-stage-button"]').waitFor({ state: 'visible', timeout: 5_000 })
            assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0, 'no Save affordance on a completed Stage')

            // The completed Stage's own screen still reads main — the approved wording, not
            // hld-define's still-unmerged rewording.
            const problemField = page.locator('.field-markdown .cm-content').first()
            await assert.doesNotReject(
              (async () => {
                const text = await problemField.textContent()
                assert.match(text, /Approved baseline problem statement\./)
                assert.doesNotMatch(text, /Reworded during HLD review/)
              })()
            )

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

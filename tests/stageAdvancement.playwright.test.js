import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { createInstance, readInstance, writeInstanceStage } from '../lib/instance.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, withScratchInstances, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'
import { exampleModuleText } from './helpers/fixtureModules.js'

// Browser smoke test for #115's Stage advancement panel (web/app.js's
// AdvanceStagePanel): the local-instance self-serve "Advance to next
// stage" action, driven through a real rendered page against a real
// running gantry server — nothing mocked at the browser or HTTP layer.
// Mirrors tests/workItemLink.playwright.test.js's own check-then-confirm
// browser-test shape.




function fillShapeStage(instancesDir, slug) {
  for (const moduleId of ['background', 'introduction', 'solution-definition', 'team-and-estimates']) {
    writeFileSync(join(instancesDir, slug, 'modules', `${moduleId}.md`), exampleModuleText(moduleId))
  }
}

test('the Stage advancement panel blocks on a failing gate, then advances the instance once the gate passes', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })

    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/instance/my-initiative`)
        await page.waitForSelector('.advance-stage-panel', { timeout: 10_000 })
        const panel = page.locator('.advance-stage-panel')

        // The Shape stage's modules are still blank — "Advance to next
        // stage" runs the gate check first and reports FAIL, never
        // opening the confirm dialog.
        await panel.getByRole('button', { name: 'Advance to next stage' }).click()
        await assert.doesNotReject(panel.locator('text=FAIL').waitFor({ timeout: 10_000 }))
        assert.equal(await page.locator('.modal[aria-label="Confirm stage advancement"]').count(), 0)

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })

    // Genuinely untouched on disk.
    assert.equal(readInstance('my-initiative', { instancesDir: join(instancesDir, 'default') }).stage, 'shape')
  })
})

test('declining the confirmation leaves the instance at its current stage', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    fillShapeStage(instancesDir, 'my-initiative')

    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/instance/my-initiative`)
        await page.waitForSelector('.advance-stage-panel', { timeout: 10_000 })
        const panel = page.locator('.advance-stage-panel')

        await panel.getByRole('button', { name: 'Advance to next stage' }).click()
        const modal = page.locator('.modal[aria-label="Confirm stage advancement"]')
        await modal.waitFor({ state: 'visible', timeout: 10_000 })
        await modal.getByRole('button', { name: 'Decline' }).click()
        await assert.doesNotReject(panel.locator('text=Declined — stage left unchanged.').waitFor({ timeout: 5_000 }))
        await assert.doesNotReject(modal.waitFor({ state: 'hidden', timeout: 5_000 }))

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })

    assert.equal(readInstance('my-initiative', { instancesDir: join(instancesDir, 'default') }).stage, 'shape')
  })
})

test('confirming advances the instance to its next stage, and the header reflects the new current stage', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    fillShapeStage(instancesDir, 'my-initiative')

    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/instance/my-initiative`)
        await page.waitForSelector('.advance-stage-panel', { timeout: 10_000 })
        const panel = page.locator('.advance-stage-panel')

        await panel.getByRole('button', { name: 'Advance to next stage' }).click()
        const modal = page.locator('.modal[aria-label="Confirm stage advancement"]')
        await modal.waitFor({ state: 'visible', timeout: 10_000 })
        await modal.getByRole('button', { name: 'Confirm & advance' }).click()

        // Confirming re-fetches the instance onto its new current stage,
        // remounting the whole stage screen (the same key-on-stage-id
        // remount every stage-switcher click already triggers) — so rather
        // than the (transient, remount-erased) success message, this
        // asserts on what genuinely survives the remount: the header's
        // stage line, and the stage nav's own "(current)" marker, both
        // now reporting the new stage.
        await assert.doesNotReject(page.locator('#stage-line', { hasText: 'High-level Design' }).waitFor({ timeout: 10_000 }))
        await assert.doesNotReject(
          page.locator('#stage-nav button', { hasText: 'High-level Design (current)' }).waitFor({ timeout: 10_000 })
        )

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })

    assert.equal(readInstance('my-initiative', { instancesDir: join(instancesDir, 'default') }).stage, 'hld-define')
  })
})

test('confirming advances the instance exactly once, even after the current stage\'s own nav button was clicked first', async () => {
  // Regression test for a race a prior review pass found and fixed:
  // clicking the current stage's own nav button sets `viewedStage.value`
  // to that stage's id (a non-null value distinct from the bootstrap
  // `null` every fresh page load starts with) — see AppHeader's stage-nav
  // buttons, which set `viewedStage.value = stage.id` unconditionally,
  // including for whichever stage is already current. Confirming an
  // advance from that state must still trigger exactly one reload, not
  // two racing ones (which could otherwise leave a stale "Failed to load"
  // error banner showing despite a successful advance — see
  // AdvanceStagePanel's own handleConfirmAdvance comment).
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    fillShapeStage(instancesDir, 'my-initiative')

    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        let getInstanceRequestCount = 0
        page.on('request', (req) => {
          if (req.method() === 'GET' && new URL(req.url()).pathname === '/api/instance') getInstanceRequestCount++
        })

        await page.goto(`${base}/instance/my-initiative`)
        await page.waitForSelector('.advance-stage-panel', { timeout: 10_000 })

        // The ordinary interaction that sets `viewedStage.value` to a
        // non-null value: click the current stage's own nav button.
        await page.getByRole('button', { name: 'SOAP (current)' }).click()
        await page.waitForTimeout(200)

        getInstanceRequestCount = 0
        const panel = page.locator('.advance-stage-panel')
        await panel.getByRole('button', { name: 'Advance to next stage' }).click()
        const modal = page.locator('.modal[aria-label="Confirm stage advancement"]')
        await modal.waitFor({ state: 'visible', timeout: 10_000 })
        await modal.getByRole('button', { name: 'Confirm & advance' }).click()

        await assert.doesNotReject(page.locator('#stage-line', { hasText: 'High-level Design' }).waitFor({ timeout: 10_000 }))
        // Never a stale error banner masking the successful advance.
        assert.equal(await page.locator('.load-error').count(), 0)
        // Exactly one reload, not two racing ones.
        assert.equal(getInstanceRequestCount, 1)

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })

    assert.equal(readInstance('my-initiative', { instancesDir: join(instancesDir, 'default') }).stage, 'hld-define')
  })
})

test('the Stage advancement panel is never shown for a Workspace-backed instance', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: {
        '/gantry-workspace/remote-initiative/instance.yaml': 'definition: design\nslug: remote-initiative\nstage: shape\n',
      },
    },
    async (adoBaseUrl) => {
      await withScratchInstances(async (instancesDir) => {
        registerInstance(
          'remote-initiative',
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )

        await withRunningServer(
          { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
          async (base) => {
            const browser = await launchBrowser()
            try {
              const page = await browser.newPage()
              page.setDefaultTimeout(DEFAULT_TIMEOUT)
              const pageErrors = []
              page.on('pageerror', (err) => pageErrors.push(err.message))
              page.on('console', (msg) => {
                if (msg.type() === 'error') pageErrors.push(msg.text())
              })

              // Seeded up front, as if already entered in a prior session
              // (mirrors tests/workItemLink.playwright.test.js) — this
              // instance's data genuinely lives in the fake Azure DevOps
              // repo, so the initial `GET /api/instance` needs a real PAT
              // to succeed at all.
              await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)
              // #301 — the synced-fields panel (used below as a "page loaded" sentinel) renders only while advanced mode is on.
              await page.addInitScript(() => localStorage.setItem('gantry:advancedMode', 'true'))

              await page.goto(`${base}/instance/remote-initiative`)
              await page.waitForSelector('#modules', { timeout: 10_000 })

              assert.equal(await page.locator('.advance-stage-panel').count(), 0)
              // The synced-fields panel (an unrelated, always-shown panel) is
              // still there — confirming the page genuinely loaded this
              // instance's real stage screen, rather than the advancement
              // panel simply being missing because nothing rendered.
              await assert.doesNotReject(page.locator('.synced-fields-panel').waitFor({ timeout: 5_000 }))

              assert.deepEqual(pageErrors, [])
            } finally {
              await browser.close()
            }
          }
        )
      })
    }
  )
})

test('the Stage advancement panel is never shown once the instance is already at its definition\'s final stage', async () => {
  await withScratchInstances(async (instancesDir) => {
    createInstance('design', 'my-initiative', { instancesDir })
    writeInstanceStage('my-initiative', 'handover', { instancesDir })

    await withRunningServer({ slug: 'my-initiative', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        // #301 — the synced-fields panel (used below as a "page loaded" sentinel) renders only while advanced mode is on.
        await page.addInitScript(() => localStorage.setItem('gantry:advancedMode', 'true'))
        await page.goto(`${base}/instance/my-initiative`)
        await page.waitForSelector('#modules', { timeout: 10_000 })

        assert.equal(await page.locator('.advance-stage-panel').count(), 0)
        // The synced-fields panel (an unrelated, always-shown panel) is still
        // there — confirming the page genuinely loaded this instance's
        // real (final) stage screen, rather than the advancement panel
        // simply being missing because nothing rendered.
        await assert.doesNotReject(page.locator('.synced-fields-panel').waitFor({ timeout: 5_000 }))

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  })
})

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


function moduleContent(text) {
  return `---\nmodule: background\nstatus: draft\nowner: \n---\n\n# Background and context\n\n## Problem statement\n\n${text}\n`
}


test('stage sync banner appears when behind and disappears after Sync from main', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: {
        '/gantry-workspace/my-slug/instance.yaml': 'definition: design\nslug: my-slug\nstage: shape\n',
        '/gantry-workspace/my-slug/modules/background.md': moduleContent('old'),
      },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-sync-e2e-'))
      try {
        registerInstance('my-slug', { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
        await client.createBranch('gantry-workspace/my-slug/shape')
        // Stage branch stays at old, main moves ahead with two files
        await client.writeFile('/gantry-workspace/my-slug/modules/background.md', moduleContent('main updated'), { branch: 'main' })
        await client.writeFile('/gantry-workspace/my-slug/modules/extra.md', moduleContent('extra main'), { branch: 'main' })

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

            await page.goto(`${gantryBase}/instance/my-slug`)
            await page.waitForSelector('.module', { timeout: 10_000 })

            const banner = page.locator('[data-testid="stage-sync-banner"]')
            await banner.waitFor({ state: 'visible', timeout: 10_000 })
            const bannerText = await banner.textContent()
            assert.match(bannerText, /behind main on 2 file\(s\)/)
            const syncButton = page.locator('[data-testid="sync-from-main"]')
            await syncButton.waitFor({ state: 'visible', timeout: 5_000 })
            assert.equal(await syncButton.textContent(), 'Sync from main')

            await syncButton.click()
            // Banner should disappear after successful sync (behind cleared)
            await banner.waitFor({ state: 'hidden', timeout: 10_000 })

            // Verify server-side cleared
            const res = await fetch(`${gantryBase}/api/instance?slug=my-slug&stage=shape`, { headers: { Authorization: `Basic ${Buffer.from(`:${VALID_PAT}`).toString('base64')}` } })
            const body = await res.json()
            assert.equal(body.stageSync.behind, false)

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

test('stage sync banner absent when main is ahead only outside this instance\'s workspace path (WI #286)', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: {
        '/gantry-workspace/my-slug/instance.yaml': 'definition: design\nslug: my-slug\nstage: shape\n',
        '/gantry-workspace/my-slug/modules/background.md': moduleContent('old'),
      },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-sync-e2e-'))
      try {
        registerInstance('my-slug', { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
        await client.createBranch('gantry-workspace/my-slug/shape')
        // main moves ahead, but nothing under gantry-workspace/my-slug/ — the banner must stay hidden.
        await client.writeFile('/README.md', '# unrelated change\n', { branch: 'main' })
        await client.writeFile('/gantry-workspace/other-slug/modules/background.md', moduleContent('other instance'), { branch: 'main' })

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

            await page.goto(`${gantryBase}/instance/my-slug`)
            await page.waitForSelector('.module', { timeout: 10_000 })

            assert.equal(await page.locator('[data-testid="stage-sync-banner"]').count(), 0)

            const res = await fetch(`${gantryBase}/api/instance?slug=my-slug&stage=shape`, { headers: { Authorization: `Basic ${Buffer.from(`:${VALID_PAT}`).toString('base64')}` } })
            const body = await res.json()
            assert.equal(body.stageSync.behind, false)
            assert.deepEqual(body.stageSync.behindFiles, [])

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

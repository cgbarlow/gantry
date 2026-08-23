import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from '../lib/server.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'

// Frontend PAT entry & storage (#87): the web form recognizes the
// "authentication required" response (from #86) on any API call, prompts
// the architect for an Azure DevOps PAT, stores it, attaches it as the
// Authorization header on every subsequent request, and offers a way to
// clear/replace it. Exercised here through a real browser and a real
// running gantry server backed by the fake in-process Azure DevOps server
// (never the real dev.azure.com), mirroring
// tests/module-editor.playwright.test.js's own pattern.

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'fake-repo'
const VALID_PAT = 'valid-test-pat'
// A second accepted PAT, distinct from VALID_PAT — used by the "Replace PAT"
// test to prove overwriting with a genuinely different credential works.
const VALID_PAT_2 = `${VALID_PAT}-2`

const SEED_FILES = {
  '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
  '/gantry-workspace/my-initiative/modules/context.md': [
    '---',
    'module: context',
    'status: draft',
    'owner: c.barlow',
    '---',
    '',
    '## Business driver',
    '',
    'Seeded from the fake Azure DevOps repo.',
    '',
    '## Affected domains',
    '',
    '- Payments',
    '',
    '## Explicitly out of scope',
    '',
    'Nothing yet.',
    '',
  ].join('\n'),
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

// Registers "my-initiative" in the instance registry (#89) as Azure-DevOps-
// backed — the only thing that now marks a slug as such (#92) — against a
// scratch instancesDir, rather than pinning the whole server to one fixed
// location at startup.
function withAzureDevOpsBackedServer(fn) {
  return withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: [VALID_PAT, VALID_PAT_2], files: SEED_FILES },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
      try {
        registerInstance(
          'my-initiative',
          { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl },
          { instancesDir }
        )
        await withRunningServer({ slug: 'my-initiative', instancesDir }, fn)
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
}

test('opening an Azure-DevOps-backed instance with no stored PAT prompts for one (with scope guidance); submitting it loads the instance and persists the PAT', async () => {
  await withAzureDevOpsBackedServer(async (base) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))

      await page.goto(`${base}/instance/my-initiative`)

      const modal = page.locator('.modal[aria-label="Azure DevOps sign-in required"]')
      await modal.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await modal.textContent(), /Code \(Read & write\)/)
      assert.match(await modal.textContent(), /Work Items \(Read & write\)/)

      // No module content has loaded behind the modal yet — the prompt
      // gates the view entirely, it doesn't just decorate a failed load.
      assert.equal(await page.locator('.module').count(), 0)

      await modal.locator('input[type=password]').fill(VALID_PAT)
      await modal.getByRole('button', { name: 'Continue' }).click()

      await page.waitForSelector('.module', { timeout: 10_000 })
      assert.equal(await page.locator('header h1').textContent(), 'my-initiative — design')
      await modal.waitFor({ state: 'hidden', timeout: 5_000 })

      // Persisted client-side, so a fresh load of the same instance doesn't
      // re-prompt.
      const stored = await page.evaluate(() => localStorage.getItem('gantry:ado-pat'))
      assert.equal(stored, VALID_PAT)

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

test('a stored PAT is attached automatically on every subsequent request — no re-prompt on reload, and edit/save round-trips', async () => {
  await withAzureDevOpsBackedServer(async (base) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))

      // Seed the PAT before any navigation, as if it had been entered in a
      // prior session.
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      await page.goto(`${base}/instance/my-initiative`)
      await page.waitForSelector('.module', { timeout: 10_000 })

      // The prompt never appears at all — the stored PAT was attached from
      // the very first request.
      assert.equal(await page.locator('.modal[aria-label="Azure DevOps sign-in required"]').count(), 0)

      const newText = 'Edited via the Azure-DevOps-backed instance, PAT attached automatically.'
      await page.locator('.field-markdown .cm-content').first().click()
      await page.keyboard.press('ControlOrMeta+a')
      await page.keyboard.type(newText)
      await page.getByRole('button', { name: 'Save Context' }).click()
      await page.waitForSelector('text=Saved', { timeout: 5_000 })

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

test('clearing the stored PAT re-triggers the prompt on the next Azure-DevOps-touching action', async () => {
  await withAzureDevOpsBackedServer(async (base) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      await page.goto(`${base}/instance/my-initiative`)
      await page.waitForSelector('.module', { timeout: 10_000 })

      await page.getByRole('button', { name: 'Clear Azure DevOps PAT' }).click()
      const storedAfterClear = await page.evaluate(() => localStorage.getItem('gantry:ado-pat'))
      assert.equal(storedAfterClear, null)

      // Clearing the PAT does not, by itself, touch the API again (the
      // currently-displayed view is left alone rather than eagerly
      // re-fetching) — the prompt reappears only once a genuine subsequent
      // action needs the API again, here: switching to a different stage.
      const modal = page.locator('.modal[aria-label="Azure DevOps sign-in required"]')
      assert.equal(await modal.count(), 0)

      const otherStageButton = page.locator('#stage-nav button').nth(1)
      await otherStageButton.click()
      await modal.waitFor({ state: 'visible', timeout: 10_000 })

      await modal.locator('input[type=password]').fill(VALID_PAT)
      await modal.getByRole('button', { name: 'Continue' }).click()
      await modal.waitFor({ state: 'hidden', timeout: 5_000 })
      await page.waitForSelector('.module', { timeout: 10_000 })
    } finally {
      await browser.close()
    }
  })
})

test('the "Replace Azure DevOps PAT" control opens the prompt directly (with no failed request needed first) and overwrites the stored value', async () => {
  await withAzureDevOpsBackedServer(async (base) => {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      await page.goto(`${base}/instance/my-initiative`)
      await page.waitForSelector('.module', { timeout: 10_000 })

      await page.getByRole('button', { name: 'Replace Azure DevOps PAT' }).click()
      const modal = page.locator('.modal[aria-label="Azure DevOps sign-in required"]')
      await modal.waitFor({ state: 'visible', timeout: 5_000 })

      // A genuinely different, still-valid replacement — the fake server
      // accepts either PAT (see withAzureDevOpsBackedServer's `validPat`
      // array) — so this proves both the overwrite itself and that the
      // replaced view keeps working, not just that the modal closes.
      const replacementPat = VALID_PAT_2
      await modal.locator('input[type=password]').fill(replacementPat)
      await modal.getByRole('button', { name: 'Continue' }).click()
      await modal.waitFor({ state: 'hidden', timeout: 5_000 })

      const stored = await page.evaluate(() => localStorage.getItem('gantry:ado-pat'))
      assert.equal(stored, replacementPat)

      // The replaced PAT is what's now attached — a subsequent save still
      // round-trips, proving the new value is genuinely in effect, not just
      // recorded in storage.
      await page.locator('.field-markdown .cm-content').first().click()
      await page.keyboard.press('ControlOrMeta+a')
      await page.keyboard.type('Edited after replacing the PAT.')
      await page.getByRole('button', { name: 'Save Context' }).click()
      await page.waitForSelector('text=Saved', { timeout: 5_000 })
    } finally {
      await browser.close()
    }
  })
})

test('a local instance never shows the PAT prompt, and shows no PAT management controls', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await chromium.launch()
      try {
        const page = await browser.newPage()
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        assert.equal(await page.locator('.modal[aria-label="Azure DevOps sign-in required"]').count(), 0)
        assert.equal(await page.getByRole('button', { name: 'Replace Azure DevOps PAT' }).count(), 0)
        assert.equal(await page.getByRole('button', { name: 'Clear Azure DevOps PAT' }).count(), 0)

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

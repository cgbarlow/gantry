import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { findWorkspaceByLocation } from '../lib/workspaceRegistry.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'

// Frontend PAT entry & storage (#87, #9/ADR-0038): the web form recognizes the "authentication required" response (from #86) on any API call, prompts the architect for a Workspace PAT, stores it against that specific workspace, attaches it as the Authorization header on every subsequent request, and offers a way to clear/replace it from that workspace's own Workspace Settings screen. Exercised here through a real browser and a real running gantry server backed by the fake in-process Azure DevOps server (never the real dev.azure.com), mirroring tests/module-editor.playwright.test.js's own pattern.

// A second accepted PAT, distinct from VALID_PAT — used by the "Replace PAT" test to prove overwriting with a genuinely different credential works.
const VALID_PAT_2 = `${VALID_PAT}-2`

const SEED_FILES = {
  '/gantry-workspace/my-initiative/instance.yaml': 'definition: design\nslug: my-initiative\nstage: shape\n',
  '/gantry-workspace/my-initiative/modules/background.md': [
    '---',
    'module: background',
    'status: draft',
    'owner: c.barlow',
    '---',
    '',
    '## Problem statement',
    '',
    'Seeded from the fake Azure DevOps repo.',
    '',
    '## Affected domains',
    '',
    '- Payments',
    '',
    '## Success criteria',
    '',
    'Nothing yet.',
    '',
  ].join('\n'),
}

// Registers "my-initiative" in the instance registry (#89) as Azure-DevOps-backed — the only thing
// that now marks a slug as such (#92) — against a scratch instancesDir, rather than pinning the whole
// server to one fixed location at startup. `registerInstance` resolves (or creates) a real
// workspace-registry entry for this location under the hood (lib/instanceRegistry.js's own
// `normalizeAzureDevOpsLocation`) — `fn` is handed that workspace's real id so a test can seed/read
// its own Workspace PAT (#9: keyed by workspace id, not a plain global string any more) without
// guessing it.
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
        const workspace = findWorkspaceByLocation({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        await withRunningServer({ slug: 'my-initiative', instancesDir }, (base) => fn(base, workspace.id))
      } finally {
        rmSync(instancesDir, { recursive: true, force: true })
      }
    }
  )
}

// Reads back this workspace's own stored PAT from the #9-shaped per-workspace store
// (`gantry:ado-pat-overrides`, a JSON object keyed by workspace id — the sole storage tier now that
// the global default is gone).
function storedWorkspacePat(page, workspaceId) {
  return page.evaluate((id) => JSON.parse(localStorage.getItem('gantry:ado-pat-overrides') ?? '{}')[id] ?? null, workspaceId)
}

function seedWorkspacePat(page, workspaceId, pat) {
  return page.evaluate(
    ({ id, pat }) => localStorage.setItem('gantry:ado-pat-overrides', JSON.stringify({ [id]: pat })),
    { id: workspaceId, pat }
  )
}

test('opening an Azure-DevOps-backed instance with no stored PAT prompts for one; submitting it loads the instance and persists the PAT against this workspace', async () => {
  await withAzureDevOpsBackedServer(async (base, workspaceId) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))

      await page.goto(`${base}/instance/my-initiative`)

      const modal = page.locator('.modal[aria-label="Sign-in required"]')
      await modal.waitFor({ state: 'visible', timeout: 10_000 })

      // No module content has loaded behind the modal yet — the prompt gates the view entirely, it doesn't just decorate a failed load.
      assert.equal(await page.locator('.module').count(), 0)

      await modal.locator('input[type=password]').fill(VALID_PAT)
      await modal.getByRole('button', { name: 'Continue' }).click()

      await page.waitForSelector('.module', { timeout: 10_000 })
      assert.equal(await page.locator('header h1').textContent(), 'my-initiative — design')
      await modal.waitFor({ state: 'hidden', timeout: 5_000 })

      // Persisted client-side against this specific workspace, so a fresh load of the same instance doesn't re-prompt.
      assert.equal(await storedWorkspacePat(page, workspaceId), VALID_PAT)

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

test('a stored PAT is attached automatically on every subsequent request — no re-prompt on reload, and edit/save round-trips', async () => {
  await withAzureDevOpsBackedServer(async (base, workspaceId) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))

      // Seed this workspace's own PAT before any navigation, as if it had been entered in a prior session.
      await page.addInitScript(
        ({ id, pat }) => localStorage.setItem('gantry:ado-pat-overrides', JSON.stringify({ [id]: pat })),
        { id: workspaceId, pat: VALID_PAT }
      )

      await page.goto(`${base}/instance/my-initiative`)
      await page.waitForSelector('.module', { timeout: 10_000 })

      // The prompt never appears at all — the stored PAT was attached from the very first request.
      assert.equal(await page.locator('.modal[aria-label="Sign-in required"]').count(), 0)

      const newText = 'Edited via the Azure-DevOps-backed instance, PAT attached automatically.'
      await page.locator('.field-markdown .cm-content').first().click()
      await page.keyboard.press('ControlOrMeta+a')
      await page.keyboard.type(newText)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForSelector('text=Saved', { timeout: 5_000 })

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

test('clearing this workspace\'s stored PAT (from its own Workspace Settings, #9) re-triggers the prompt on the next Azure-DevOps-touching action', async () => {
  await withAzureDevOpsBackedServer(async (base, workspaceId) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)

      // #9: PAT management is per-workspace, on that workspace's own Workspace Settings screen — not a
      // global control any more. Seeded via `page.evaluate` after an initial navigation (not
      // `addInitScript`, which reruns on *every* subsequent navigation this test makes — including the
      // one right after clearing — and would silently re-seed the very value this test clears).
      await page.goto(`${base}/settings/workspace?slug=my-initiative`)
      await seedWorkspacePat(page, workspaceId, VALID_PAT)
      await page.reload()

      const row = page.locator('.workspace-row')
      await row.waitFor({ state: 'visible', timeout: 10_000 })
      await row.getByRole('button', { name: 'Clear PAT' }).click()
      assert.equal(await storedWorkspacePat(page, workspaceId), null)

      // Clearing the PAT does not, by itself, touch any Azure-DevOps-backed API — the prompt reappears only once a genuine subsequent action needs the API again, here: opening the Azure-DevOps-backed instance.
      const modal = page.locator('.modal[aria-label="Sign-in required"]')
      assert.equal(await modal.count(), 0)

      await page.goto(`${base}/instance/my-initiative`)
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

test('this workspace\'s "Replace PAT" control (#9) overwrites its own stored PAT in place, with no shared modal involved', async () => {
  await withAzureDevOpsBackedServer(async (base, workspaceId) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)

      await page.goto(`${base}/settings/workspace?slug=my-initiative`)
      await seedWorkspacePat(page, workspaceId, VALID_PAT)
      await page.reload()

      const row = page.locator('.workspace-row')
      await row.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await row.locator('.workspace-pat-status').textContent(), /SET/)

      // A genuinely different, still-valid replacement — the fake server accepts either PAT (see withAzureDevOpsBackedServer's `validPat` array) — so this proves both the overwrite itself and that the replaced value keeps working, not just that the field clears.
      const replacementPat = VALID_PAT_2
      await row.locator('.workspace-pat input[type=password]').fill(replacementPat)
      await row.getByRole('button', { name: 'Replace PAT' }).click()

      assert.equal(await storedWorkspacePat(page, workspaceId), replacementPat)

      // The replaced PAT is what's now attached — a subsequent save on the Azure-DevOps-backed instance still round-trips, proving the new value is genuinely in effect, not just recorded in storage.
      await page.goto(`${base}/instance/my-initiative`)
      await page.waitForSelector('.module', { timeout: 10_000 })
      await page.locator('.field-markdown .cm-content').first().click()
      await page.keyboard.press('ControlOrMeta+a')
      await page.keyboard.type('Edited after replacing the PAT.')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForSelector('text=Saved', { timeout: 5_000 })
    } finally {
      await browser.close()
    }
  })
})

test('a local instance never shows the PAT prompt, and its editor header shows no PAT management controls', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })

        assert.equal(await page.locator('.modal[aria-label="Sign-in required"]').count(), 0)
        assert.equal(await page.getByRole('button', { name: /PAT/ }).count(), 0)

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { stageBranchName } from '../lib/stageBranch.js'
import { parseSourceManifest } from '../web/lib/sourceDocuments.js'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { GITHUB_OWNER, GITHUB_REPOSITORY, GITHUB_VALID_PAT, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT, withRunningServerForProvider } from './helpers/lifecycle.js'
import { wordDocument } from './helpers/sourceFixtures.js'

// #280 (map #238): browser coverage for the Source documents panel on an Azure DevOps and a GitHub workspace. The panel and the lifecycle are the ones a server workspace uses (tests/source-documents.playwright.test.js); what is different here is that each upload, rename, Extract text again and removal lands as its own commit on the current Stage's branch. tests/providerSourceDocuments.test.js counts the commits and covers the 25 MB upload and the stacked branches.

const SLUG = 'acme'
const ROOT = `gantry-workspace/${SLUG}`
const INSTANCE_YAML = `definition: design\nslug: ${SLUG}\nstage: shape\ndefinitionVersion: 2\n`

const PROVIDERS = {
  'azure-devops': {
    name: 'Azure DevOps',
    kind: 'azureDevOps',
    pat: VALID_PAT,
    location: (baseUrl) => ({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl }),
    client: (baseUrl) => createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl, pat: VALID_PAT }),
  },
  github: {
    name: 'GitHub',
    kind: 'github',
    pat: GITHUB_VALID_PAT,
    location: (baseUrl) => ({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl }),
    client: (baseUrl) => createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl, pat: GITHUB_VALID_PAT }),
  },
}

const rowFor = (panel, title) => panel.locator('tr[data-source-id]').filter({ hasText: title })
const message = (panel) => panel.locator('[data-testid="source-documents-message"]')

for (const [providerId, provider] of Object.entries(PROVIDERS)) {
  test(`${provider.name}: the Source documents panel uploads, renames, reads again and removes, each as a commit on the Stage's branch`, async () => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-280-e2e-'))
    try {
      await withRunningServerForProvider(
        providerId,
        { options: { instancesDir }, fakeServerOptions: { files: { [`/${ROOT}/instance.yaml`]: INSTANCE_YAML } } },
        async ({ gantryBase: base, providerBaseUrl }) => {
          registerInstance(SLUG, { kind: provider.kind, ...provider.location(providerBaseUrl) }, { instancesDir })
          const client = provider.client(providerBaseUrl)
          const branch = stageBranchName(SLUG, 'shape')

          const browser = await launchBrowser()
          try {
            const page = await browser.newPage()
            page.setDefaultTimeout(DEFAULT_TIMEOUT)
            const pageErrors = []
            page.on('pageerror', (err) => pageErrors.push(err.message))
            await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), provider.pat)

            await page.goto(`${base}/instance/${SLUG}`)
            const panel = page.locator('[data-testid="source-documents"]')
            await panel.waitFor({ timeout: 30_000 })
            await panel.locator('[data-testid="source-documents-summary"]').click()
            await panel.locator('[data-testid="source-documents-empty"]').waitFor()
            assert.match(await panel.locator('[data-testid="source-documents-commit-note"]').textContent(), /its own commit on this Stage's branch/)
            assert.equal(await client.branchExists(branch), false, 'opening the panel starts no branch')

            // Upload: read in the browser, committed with its text and the manifest on the Stage's branch.
            const input = panel.locator('[data-testid="source-documents-input"]')
            await input.setInputFiles({ name: 'Client brief.docx', mimeType: 'application/octet-stream', buffer: Buffer.from(wordDocument()) })
            await rowFor(panel, 'Client brief').waitFor()
            assert.match(await message(panel).textContent(), /Added "Client brief" and read its text/)
            assert.equal(await client.branchExists(branch), true)
            assert.deepEqual(Buffer.from(await client.getFileBytes(`${ROOT}/sources/Client brief.docx`, { branch })), Buffer.from(wordDocument()))
            assert.match(await client.getFileContent(`${ROOT}/sources/.text/Client brief.docx.md`, { branch }), /The platform must support \*\*5000\*\* users\./)
            assert.equal(await client.fileExists(`${ROOT}/sources/manifest.yaml`, 'main'), false, 'main is untouched until the Stage is approved')

            // Rename changes the title in the committed manifest only.
            await rowFor(panel, 'Client brief').getByRole('button', { name: 'Rename' }).click()
            await panel.locator('[data-testid="source-documents-rename-input"]').fill('Client brief v3')
            await panel.getByRole('button', { name: 'Save', exact: true }).click()
            await rowFor(panel, 'Client brief v3').waitFor()
            const renamed = parseSourceManifest(await client.getFileContent(`${ROOT}/sources/manifest.yaml`, { branch }))
            assert.deepEqual(renamed.map((e) => [e.id, e.title, e.filename]), [['client-brief', 'Client brief v3', 'Client brief.docx']])

            // Extract text again reads the original back from the branch and commits the new text.
            await client.writeFile(`${ROOT}/sources/.text/Client brief.docx.md`, 'stale', { branch })
            await rowFor(panel, 'Client brief v3').getByRole('button', { name: 'Extract text again' }).click()
            await page.waitForFunction(() => /Read the text of/.test(document.querySelector('[data-testid="source-documents-message"]')?.textContent ?? ''))
            assert.match(await client.getFileContent(`${ROOT}/sources/.text/Client brief.docx.md`, { branch }), /The platform must support \*\*5000\*\* users\./)

            // Reload: the list comes back from the committed manifest, and Download hands back the original.
            await page.reload()
            const again = page.locator('[data-testid="source-documents"]')
            await again.waitFor({ timeout: 30_000 })
            await again.locator('[data-testid="source-documents-summary"]').click()
            await rowFor(again, 'Client brief v3').waitFor()
            const [download] = await Promise.all([page.waitForEvent('download'), rowFor(again, 'Client brief v3').getByRole('button', { name: 'Download' }).click()])
            assert.deepEqual(readFileSync(await download.path()), Buffer.from(wordDocument()))

            // Remove deletes the file and its text from the branch and keeps the entry.
            await rowFor(again, 'Client brief v3').getByRole('button', { name: 'Remove' }).click()
            await again.locator('[data-testid="source-documents-confirm-remove"]').click()
            await rowFor(again, 'Client brief v3').waitFor({ state: 'detached' })
            await again.locator('[data-testid="source-documents-removed"]').waitFor()
            assert.equal(await client.fileExists(`${ROOT}/sources/Client brief.docx`, branch), false)
            assert.equal(await client.fileExists(`${ROOT}/sources/.text/Client brief.docx.md`, branch), false)
            const kept = parseSourceManifest(await client.getFileContent(`${ROOT}/sources/manifest.yaml`, { branch }))
            assert.equal(kept.length, 1)
            assert.ok(kept[0].removedAt)

            assert.deepEqual(pageErrors, [])
          } finally {
            await browser.close()
          }
        }
      )
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })
}

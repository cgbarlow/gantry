import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { loadDefinition } from '../lib/definition.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { resolveStageBranch } from '../lib/stageBranch.js'
import { resolveGitHubStageBranch } from '../lib/githubStageBranch.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import {
  withRunningServer,
  withRunningServerForProvider,
  basicAuthHeader,
  ORGANIZATION,
  PROJECT,
  REPOSITORY,
  VALID_PAT,
  GITHUB_OWNER,
  GITHUB_REPOSITORY,
  GITHUB_VALID_PAT,
} from './helpers/lifecycle.js'
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

// The Problem statement Field's body in a background module file.
function problemTextOf(text) {
  const marker = '## Problem statement\n'
  const start = text.indexOf(marker) + marker.length
  const next = text.indexOf('\n## ', start)
  return text.slice(start, next).trim()
}

// The two Providers a remote Instance can sit on. The UI is the same for both, so the first test below runs
// against each; `approve` casts the Owner's approving vote on a Pull Request through the fake's own API.
const INSTANCE_YAML = `definition: design\nslug: ${SLUG}\nstage: shape\ndefinitionVersion: 2\n`
const PROVIDERS = {
  'azure-devops': {
    name: 'Azure DevOps',
    kind: 'azureDevOps',
    pat: VALID_PAT,
    location: (baseUrl) => ({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl }),
    client: (baseUrl) => createAzureDevOpsClient({ ...PROVIDERS['azure-devops'].location(baseUrl), pat: VALID_PAT }),
    resolveBranch: (baseUrl, stageId) =>
      resolveStageBranch({ ...PROVIDERS['azure-devops'].location(baseUrl), pat: VALID_PAT }, definition, SLUG, stageId),
    deleteBranch: async (baseUrl, client, branch) => {
      const refsUrl = `${baseUrl}/${ORGANIZATION}/${PROJECT}/_apis/${'g' + 'it'}/repositories/${REPOSITORY}/refs?api-version=7.1`
      await fetch(refsUrl, {
        method: 'POST',
        headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
        body: JSON.stringify([{ name: `refs/heads/${branch}`, oldObjectId: await client.getBranchObjectId(branch), newObjectId: '0'.repeat(40) }]),
      })
    },
    approve: async (baseUrl, pullRequestId) => {
      await fetch(`${baseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}/reviewers/owner-1`, {
        method: 'PUT',
        headers: { Authorization: basicAuthHeader(VALID_PAT), 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'The Owner', vote: 10 }),
      })
    },
  },
  github: {
    name: 'GitHub',
    kind: 'github',
    pat: GITHUB_VALID_PAT,
    location: (baseUrl) => ({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl }),
    client: (baseUrl) => createGitHubClient({ ...PROVIDERS.github.location(baseUrl), pat: GITHUB_VALID_PAT }),
    resolveBranch: (baseUrl, stageId) =>
      resolveGitHubStageBranch({ ...PROVIDERS.github.location(baseUrl), pat: GITHUB_VALID_PAT }, definition, SLUG, stageId),
    deleteBranch: async (baseUrl, client, branch) => {
      await fetch(`${baseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/${'g' + 'it'}/refs/heads/${branch}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}` },
      })
    },
    approve: async (baseUrl, pullRequestId) => {
      await fetch(`${baseUrl}/repos/${GITHUB_OWNER}/${GITHUB_REPOSITORY}/pulls/${pullRequestId}/reviews`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${GITHUB_VALID_PAT}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'APPROVE' }),
      })
    },
  },
}

async function approveSoap(base, providerBaseUrl, providerId = 'azure-devops') {
  const provider = PROVIDERS[providerId]
  const headers = { Authorization: basicAuthHeader(provider.pat) }
  const client = provider.client(providerBaseUrl)
  const branch = await provider.resolveBranch(providerBaseUrl, 'shape')
  for (const moduleId of SHAPE_MODULES) {
    await client.writeFile(`gantry-workspace/${SLUG}/modules/${moduleId}.md`, exampleModuleText(moduleId), { branch })
  }
  await client.writeFile(`gantry-workspace/${SLUG}/out/Soap Drift - Solution on a Page.docx`, 'rendered soap', { branch })

  const opened = await (await fetch(`${base}/api/instance/request-approval?slug=${SLUG}`, { method: 'POST', headers })).json()
  await provider.approve(providerBaseUrl, opened.pullRequestId)
  const approved = await (await fetch(`${base}/api/instance/check-status?slug=${SLUG}`, { method: 'POST', headers })).json()
  assert.equal(approved.merged, true)

  // A merged stage's branch is cleaned up, as on a real repository: HLD's own branch then forks from `main`
  // (where the Instance already sits at HLD) instead of stacking on SOAP's leftover one.
  const shapeBranch = `gantry-workspace/${SLUG}/shape`
  await provider.deleteBranch(providerBaseUrl, client, shapeBranch)
  assert.equal(await client.branchExists(shapeBranch), false)

  return async (problem) => {
    const hldBranch = await provider.resolveBranch(providerBaseUrl, 'hld-define')
    await client.writeFile(`gantry-workspace/${SLUG}/modules/background.md`, backgroundWithProblem(exampleModuleText('background'), problem), { branch: hldBranch })
  }
}

for (const providerId of Object.keys(PROVIDERS)) {
  const provider = PROVIDERS[providerId]

  test(`${provider.name}: an approved stage whose printed Field a later stage changed is flagged on its tab, in the stage status, in the sign-off section and on the dashboard row`, async () => {
    const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-changed-since-approval-'))
    try {
      await withRunningServerForProvider(
        providerId,
        { options: { instancesDir }, fakeServerOptions: { files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: INSTANCE_YAML } } },
        async ({ gantryBase: base, providerBaseUrl }) => {
          registerInstance(SLUG, { kind: provider.kind, ...provider.location(providerBaseUrl) }, { instancesDir })
          const rewordAtHld = await approveSoap(base, providerBaseUrl, providerId)

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
            }, provider.pat)

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
              await route.continue({ headers: { ...route.request().headers(), authorization: basicAuthHeader(provider.pat) } })
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
        }
      )
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })
}

test('Restore approved text shows the approved and current wording side by side, saves the approved wording on the later stage\'s branch, and clears the flag', async () => {
  await withFakeAzureDevOpsServer(
    {
      organization: ORGANIZATION,
      project: PROJECT,
      repository: REPOSITORY,
      validPat: VALID_PAT,
      files: { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: design\nslug: ${SLUG}\nstage: shape\ndefinitionVersion: 2\n` },
    },
    async (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-restore-approved-'))
      try {
        registerInstance(SLUG, { kind: 'azureDevOps', organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: adoBaseUrl }, { instancesDir })
        await withRunningServer({ instancesDir, allowAzureDevOpsBaseUrlOverride: true, allowedAzureDevOpsBaseUrls: [adoBaseUrl] }, async (base) => {
          const rewordAtHld = await approveSoap(base, adoBaseUrl)
          const approvedProblem = problemTextOf(exampleModuleText('background'))
          assert.notEqual(approvedProblem, '')

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

            // Nothing changed: no panel.
            await page.goto(`${base}/instance/${SLUG}`)
            await page.waitForSelector('#stage-nav button', { timeout: 30_000 })
            await page.waitForSelector('#modules .module', { timeout: 30_000 })
            assert.equal(await page.locator('[data-testid="changed-since-approval-panel"]').count(), 0)

            // HLD rewords a Field SOAP prints.
            await rewordAtHld('Reworded during the HLD review.')
            await page.reload()
            await page.waitForSelector('[data-testid="changed-since-approval-panel"]', { timeout: 30_000 })

            const field = page.locator('[data-testid="changed-since-approval-panel"] [data-field="background.problem"]')
            assert.match(await field.locator('h4').textContent(), /Background.*Problem statement/)
            assert.equal((await field.locator('[data-side="approved"]').textContent()).trim(), approvedProblem)
            assert.equal((await field.locator('[data-side="current"]').textContent()).trim(), 'Reworded during the HLD review.')

            // Restore approved text: the approved wording is saved on HLD's branch and the flag goes.
            await field.locator('[data-testid="restore-approved-text"]').click()
            await page.waitForSelector('[data-testid="changed-since-approval-panel"]', { state: 'detached', timeout: 30_000 })
            assert.equal(await page.locator('[data-testid="changed-since-approval-notice"]').count(), 0)
            assert.equal(await page.locator('#stage-nav [data-changed-since-approval]').count(), 0)

            const saved = await (await fetch(`${base}/api/instance?slug=${SLUG}`, { headers })).json()
            assert.deepEqual(saved.changedSinceApproval, [])
            const background = saved.modules.find((m) => m.id === 'background')
            assert.equal(background.fields.find((f) => f.id === 'problem').value.trim(), approvedProblem)

            // And it stays that way after a reload.
            await page.reload()
            await page.waitForSelector('#modules .module', { timeout: 30_000 })
            assert.equal(await page.locator('[data-testid="changed-since-approval-panel"]').count(), 0)

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

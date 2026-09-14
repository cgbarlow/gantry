import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'
import { createBlankDefinition, writeDefinitionVersion, publishDefinitionVersion } from '../lib/definition.js'
import { serverWorkspaceDefinitionsDir } from '../lib/definitionHome.js'

// WI #387 (Feature #380 phase 7, ADR-0036's Promote section): e2e coverage for the Promote dialog
// (available only on a published workspace definition version, one Pull Request opened per
// selected library repo) and the PR link/status display, refreshed only by an explicit Check — the
// server-side branch/commit/PR-creation and multi-repo fan-out mechanics are already proven against
// the fake Azure DevOps server by tests/serverDefinitionPromote.test.js; this proves the same
// contract holds in the actual rendered UI a person uses.

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'promote-e2e-repo'
const VALID_PAT = 'promote-e2e-pat'

function seedWorkspaceDefinition(instancesDir) {
  mkdirSync(join(instancesDir, 'acme'), { recursive: true })
  writeWorkspaceJson(instancesDir, 'acme', { name: 'Acme', kind: 'local', createdAt: new Date().toISOString() })
  const definitionsDir = serverWorkspaceDefinitionsDir(instancesDir, 'acme')
  createBlankDefinition('widget-process', { definitionsDir, title: 'Widget Process' })
  const structure = {
    title: 'Widget Process',
    description: 'A process that lives in a workspace, ready to promote.',
    modules: [{ id: 'intro', title: 'Introduction', purpose: 'p', fields: [{ id: 'body', title: 'Body', type: 'markdown' }] }],
    stages: [{ id: 'kickoff', title: 'Kickoff', purpose: 'p', gate: 'kickoff-review', modules: ['intro'] }],
    artefacts: [{ id: 'doc', title: 'Doc', purpose: 'p', template: 'doc.md.tmpl', gate: 'kickoff-review', requires: ['intro'] }],
  }
  const result = writeDefinitionVersion('widget-process', 1, structure, { definitionsDir })
  assert.ok(!result.problems, `seed structure should be valid: ${JSON.stringify(result.problems)}`)
  publishDefinitionVersion('widget-process', 1, { definitionsDir })
}

function withFixtures(fn) {
  return async () => {
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p7-e2e-lib-'))
    const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p7-e2e-ws-'))
    try {
      cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
      seedWorkspaceDefinition(instancesDir)
      await withFakeAzureDevOpsServer(
        { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: { 'README.md': '# repo' } },
        async (baseUrl) => {
          await withRunningServer({ definitionsDir, instancesDir, libraryPat: VALID_PAT, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
            const addRes = await fetch(`${base}/api/library-repos`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl, codeOwner: 'testuser@example.com' }),
            })
            assert.equal(addRes.status, 201)
            await fn(base, baseUrl)
          })
        }
      )
    } finally {
      rmSync(definitionsDir, { recursive: true, force: true })
      rmSync(instancesDir, { recursive: true, force: true })
    }
  }
}

async function withPage(base, fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    page.on('dialog', (d) => d.accept())
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()) })
    await fn(page, pageErrors)
  } finally {
    await browser.close()
  }
}

async function openSwitcher(page) {
  await page.locator('.defn-switcher [data-dropdown-trigger]').click()
  await page.waitForSelector('.defn-switcher-menu, .defn-newdef-panel', { timeout: 10_000 })
}

test(
  'Promote is offered on a published workspace definition version, opens a Pull Request, and its status is read only on an explicit Check',
  withFixtures(async (base, baseUrl) => {
    await withPage(base, async (page, pageErrors) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-toolbar', { timeout: 10_000 })

      await openSwitcher(page)
      const workspaceGroup = page.locator('.defn-switcher-group').filter({ has: page.locator('.kicker', { hasText: 'Workspace: Acme' }) })
      await workspaceGroup.locator('.defn-switcher-row', { hasText: 'Widget Process' }).click()
      await page.waitForFunction(() => document.querySelector('.defn-switcher .defname')?.textContent === 'Widget Process', { timeout: 10_000 })
      await page.waitForSelector('.defn-outline-node', { timeout: 10_000 })

      const promoteBtn = page.getByRole('button', { name: 'Promote…' })
      await promoteBtn.waitFor({ state: 'visible', timeout: 10_000 })
      await promoteBtn.click()

      await page.waitForSelector('.defn-promote-modal', { timeout: 10_000 })
      await page.locator('.defn-promote-repo-list label', { hasText: REPOSITORY }).locator('input[type=checkbox]').check()
      await page.getByRole('button', { name: 'Promote', exact: true }).click()

      await page.locator('.defn-promote-modal').waitFor({ state: 'detached', timeout: 10_000 })
      await page.waitForSelector('.defn-promotions', { timeout: 10_000 })
      const promotionRow = page.locator('.defn-promotion-row', { hasText: REPOSITORY })
      await promotionRow.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await promotionRow.textContent(), /PR #\d+/)
      assert.match(await promotionRow.textContent(), /active/)
      assert.match(await promotionRow.textContent(), /pending/)

      const prLink = promotionRow.locator('a')
      const href = await prLink.getAttribute('href')
      assert.match(href, /pullrequest\/\d+$/)

      // Simulate the code owner approving in Azure DevOps directly — this page must not pick it up
      // on its own (no polling); only the explicit Check action re-reads it.
      const pullRequestId = href.match(/pullrequest\/(\d+)$/)[1]
      const voteRes = await fetch(
        `${baseUrl}/${ORGANIZATION}/${PROJECT}/_apis/git/repositories/${REPOSITORY}/pullrequests/${pullRequestId}/reviewers/fake-identity-id-001?api-version=7.1`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`:${VALID_PAT}`).toString('base64')}` },
          body: JSON.stringify({ vote: 10 }),
        }
      )
      assert.equal(voteRes.status, 200)

      // Still shows the pre-vote state with no Check click yet — nothing on this page polls for it.
      assert.match(await page.locator('.defn-promotion-row', { hasText: REPOSITORY }).textContent(), /pending/)

      await page.getByRole('button', { name: 'Check status' }).click()
      await page.waitForFunction(
        (repo) => document.querySelector('.defn-promotions')?.textContent?.includes(repo) && document.querySelector('.defn-promotions')?.textContent?.includes('approved'),
        REPOSITORY,
        { timeout: 10_000 }
      )

      assert.deepEqual(pageErrors, [])
    })
  })
)

test(
  'Promote is not offered on a draft version or on a library/library-repo definition',
  withFixtures(async (base) => {
    await withPage(base, async (page, pageErrors) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-toolbar', { timeout: 10_000 })

      // The packaged library's own "design" definition — never a workspace, so Promote never shows.
      await openSwitcher(page)
      const libraryGroup = page.locator('.defn-switcher-group').filter({ has: page.locator('.kicker', { hasText: 'Server library' }) })
      await libraryGroup.locator('.defn-switcher-row').first().click()
      await page.waitForSelector('.defn-outline-node', { timeout: 10_000 })
      assert.equal(await page.getByRole('button', { name: 'Promote…' }).count(), 0)

      assert.deepEqual(pageErrors, [])
    })
  })
)

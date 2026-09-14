import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import yaml from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { createBlankAzureDevOpsDefinition, writeAzureDevOpsDefinitionVersion, publishAzureDevOpsDefinitionVersion } from '../lib/definitionAzureDevOps.js'
import { writeWorkspaceJson } from '../lib/workspaceDirectory.js'

// WI #386 (Feature #380 phase 6, ADR-0036): e2e coverage for a library-repo-sourced definition's
// read-only posture in the Definitions editor — viewable, copyable-from, clonable into a workspace,
// but never directly editable — plus the explicit Refresh button. `tests/serverLibraryRepos.test.js`
// already covers the union/clash/cache/Refresh mechanics at the HTTP layer against the fake Azure
// DevOps server; this proves the same read-only contract holds in the actual rendered UI a person
// uses.

const ORGANIZATION = 'fake-org'
const PROJECT = 'fake-project'
const REPOSITORY = 'lib-repo-readonly-e2e'
const VALID_PAT = 'library-readonly-e2e-pat'

async function seedLibraryRepoDefinition(azureDevOps) {
  await createBlankAzureDevOpsDefinition('widget-process', { azureDevOps }, { title: 'Widget Process' })
  const structure = {
    title: 'Widget Process',
    description: 'A process that lives in a library repo.',
    modules: [{ id: 'intro', title: 'Introduction', purpose: 'p', fields: [{ id: 'body', title: 'Body', type: 'markdown' }] }],
    stages: [{ id: 'kickoff', title: 'Kickoff', purpose: 'p', gate: 'kickoff-review', modules: ['intro'] }],
    artefacts: [{ id: 'doc', title: 'Doc', purpose: 'p', template: 'doc.md.tmpl', gate: 'kickoff-review', requires: ['intro'] }],
  }
  const result = await writeAzureDevOpsDefinitionVersion('widget-process', 1, structure, { azureDevOps })
  assert.ok(!result.problems, `seed structure should be valid: ${JSON.stringify(result.problems)}`)
  await publishAzureDevOpsDefinitionVersion('widget-process', 1, { azureDevOps })
}

// A real, writable draft in a server workspace ("acme") — the copy-into and clone-into target, and
// the definition open while proving the docked Library panel offers the library-repo definition as
// a copy source (WI #382's eligibility rule, extended by this ticket).
function seedWorkspaceDraft(instancesDir) {
  mkdirSync(join(instancesDir, 'acme'), { recursive: true })
  writeWorkspaceJson(instancesDir, 'acme', { name: 'Acme', kind: 'local', createdAt: new Date().toISOString() })
  const targetDir = join(instancesDir, 'acme', 'definitions', 'acme-draft', '1')
  mkdirSync(join(targetDir, 'modules'), { recursive: true })
  writeFileSync(
    join(targetDir, 'definition.yaml'),
    yaml.stringify({
      id: 'acme-draft',
      version: 1,
      status: 'draft',
      title: 'Acme Draft',
      description: '',
      stages: [{ id: 'shape', title: 'Shape', purpose: '', gate: 'business-case', modules: [] }],
      artefacts: [],
    })
  )
  writeFileSync(join(targetDir, 'CHANGELOG.md'), '## v1\n\nDraft.\n')
}

function withFixtures(fn) {
  return async () => {
    const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-p6-readonly-lib-'))
    const instancesDir = mkdtempSync(join(tmpdir(), 'defs-p6-readonly-ws-'))
    try {
      seedWorkspaceDraft(instancesDir)
      await withFakeAzureDevOpsServer({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT }, async (baseUrl) => {
        const azureDevOps = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl, pat: VALID_PAT }
        await seedLibraryRepoDefinition(azureDevOps)
        await withRunningServer({ definitionsDir, instancesDir, libraryPat: VALID_PAT, allowAzureDevOpsBaseUrlOverride: true }, async (base) => {
          const addRes = await fetch(`${base}/api/library-repos`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl }),
          })
          const addBody = await addRes.json()
          assert.equal(addRes.status, 201, JSON.stringify(addBody))
          assert.equal(addBody.refresh.ok, true, JSON.stringify(addBody.refresh))
          await fn(base)
        })
      })
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

async function closeSwitcherIfOpen(page) {
  if (await page.locator('.defn-switcher-menu, .defn-newdef-panel').isVisible().catch(() => false)) {
    await page.locator('.defn-switcher [data-dropdown-trigger]').click()
    await page.locator('.defn-switcher-menu, .defn-newdef-panel').waitFor({ state: 'hidden', timeout: 10_000 })
  }
}

test(
  'a library repo definition is grouped under its own switcher heading, viewable, and offers no editing affordance',
  withFixtures(async (base) => {
    await withPage(base, async (page, pageErrors) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-toolbar', { timeout: 10_000 })

      await openSwitcher(page)
      const repoGroup = page.locator('.defn-switcher-group').filter({ has: page.locator('.kicker', { hasText: `Library repo: ${ORGANIZATION}/${PROJECT}/${REPOSITORY}` }) })
      const repoRow = repoGroup.locator('.defn-switcher-row', { hasText: 'Widget Process' })
      await repoRow.waitFor({ state: 'visible', timeout: 10_000 })
      // Read-only in the switcher itself: no Archive affordance on a library-repo row.
      assert.equal(await repoRow.getByRole('button', { name: 'Archive' }).count(), 0)
      await repoRow.click()

      await page.waitForFunction(() => document.querySelector('.defn-switcher .defname')?.textContent === 'Widget Process', { timeout: 10_000 })
      await page.waitForSelector('.defn-outline-node', { timeout: 10_000 })
      const bodyText = await page.locator('body').innerText()
      assert.match(bodyText, /Kickoff/, 'the library-repo definition\'s own stage renders')
      assert.match(bodyText, /Read-only — published\./)

      // No editing affordances at all — save/publish/new-draft are entirely absent, not merely
      // disabled, matching "no direct edit" (WI #386).
      assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).count(), 0)
      assert.equal(await page.getByRole('button', { name: 'Publish', exact: true }).count(), 0)
      assert.equal(await page.getByRole('button', { name: 'New draft version' }).count(), 0)

      assert.deepEqual(pageErrors, [])
    })
  })
)

test(
  'a library repo definition\'s content is copyable-from into a workspace draft',
  withFixtures(async (base) => {
    await withPage(base, async (page, pageErrors) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-toolbar', { timeout: 10_000 })
      await openSwitcher(page)
      await page.locator('.defn-switcher-row', { hasText: 'Acme Draft' }).click()
      await page.waitForSelector('.defn-workbench', { timeout: 10_000 })
      await page.waitForSelector('.defn-library-tree', { timeout: 10_000 })

      const libraryNode = page.locator('.defn-library-node').filter({ hasText: 'Kickoff' }).first()
      await libraryNode.locator('.defn-library-copy-btn').click()
      await page.waitForSelector('.defn-copy-modal', { timeout: 10_000 })
      assert.match(await page.locator('.defn-copy-modal h3').textContent(), /stage "kickoff"/)
      const confirmBtn = page.locator('.defn-copy-modal').getByRole('button', { name: 'Confirm copy' })
      await confirmBtn.click()
      await page.waitForSelector('.defn-copy-modal', { state: 'detached', timeout: 10_000 })

      const landed = page.locator('.defn-outline-node').filter({ hasText: 'Kickoff' })
      await landed.waitFor({ state: 'visible', timeout: 10_000 })
      assert.match(await landed.textContent(), /from .*v1/)
      assert.deepEqual(pageErrors, [])
    })
  })
)

test(
  'a library repo definition clones into a chosen workspace as an independent, editable draft',
  withFixtures(async (base) => {
    await withPage(base, async (page, pageErrors) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-toolbar', { timeout: 10_000 })
      await openSwitcher(page)
      await page.locator('.defn-switcher-row', { hasText: 'Widget Process' }).click()
      await page.waitForFunction(() => document.querySelector('.defn-switcher .defname')?.textContent === 'Widget Process', { timeout: 10_000 })

      await openSwitcher(page)
      await page.getByRole('button', { name: '+ New definition…' }).click()
      await page.getByRole('button', { name: 'Clone current' }).click()
      await page.locator('#defn-newdef-clone-id').fill('widget-process-clone')
      await page.locator('#defn-newdef-clone-home').selectOption({ label: 'Workspace: Acme' })
      await page.getByRole('button', { name: 'Create', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.defn-switcher .defname')?.textContent === 'Widget Process', { timeout: 10_000 })

      // The clone is a real, independent, editable workspace draft — not the read-only source.
      await openSwitcher(page)
      const workspaceGroup = page.locator('.defn-switcher-group').filter({ has: page.locator('.kicker', { hasText: 'Workspace: Acme' }) })
      await workspaceGroup.locator('.defn-switcher-row', { hasText: 'Widget Process' }).click()
      await page.waitForFunction(() => document.querySelector('.defn-switcher .defname')?.textContent === 'Widget Process', { timeout: 10_000 })
      await page.waitForSelector('.defn-outline-node', { timeout: 10_000 })
      const bodyText = await page.locator('body').innerText()
      assert.match(bodyText, /Kickoff/, "the clone carries the source's stage")
      await page.getByRole('button', { name: 'Save', exact: true }).waitFor({ state: 'visible', timeout: 10_000 })
      assert.equal(await page.getByRole('button', { name: 'Publish', exact: true }).count(), 1, 'the clone is a draft — publishable, unlike its read-only source')

      assert.deepEqual(pageErrors, [])
    })
  })
)

test(
  'the Refresh button re-reads every configured library repo without error',
  withFixtures(async (base) => {
    await withPage(base, async (page, pageErrors) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-toolbar', { timeout: 10_000 })

      const refreshBtn = page.getByRole('button', { name: /^Refresh$/ })
      await refreshBtn.click()
      await page.waitForFunction(() => !/Refreshing…/.test(document.querySelector('.defn-toolbar-left button')?.textContent ?? ''), { timeout: 10_000 })

      assert.equal(await page.locator('.defn-library-problem').count(), 0, 'no clash to report in this fixture')
      await closeSwitcherIfOpen(page)
      await openSwitcher(page)
      const repoGroup = page.locator('.defn-switcher-group').filter({ has: page.locator('.kicker', { hasText: `Library repo: ${ORGANIZATION}/${PROJECT}/${REPOSITORY}` }) })
      await repoGroup.locator('.defn-switcher-row', { hasText: 'Widget Process' }).waitFor({ state: 'visible', timeout: 10_000 })

      assert.deepEqual(pageErrors, [])
    })
  })
)

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { withRunningServer, basicAuthHeader, VALID_PAT } from './helpers/lifecycle.js'
import { createAzureDevOpsClient, AzureDevOpsNotFoundError } from '../lib/azureDevOpsClient.js'

// Browser tests for WI #305 — "Import a local-workspace instance into a
// Server-hosted workspace": the "Start blank" / "Import from local
// workspace" data-source toggle inside the Register panel of Server-hosted
// mode (web/pages/new-workspace-wizard.js), added on top of A4's Local flow
// (WI #295) and #110's Server-hosted Register/Pick flow.
//
// Two test techniques are combined here, exactly as the ticket's own
// research pointed at:
//   - the OPFS-based File System Access API mock from
//     tests/wizard-local-workspace.playwright.test.js (`page.addInitScript`
//     replacing `window.showDirectoryPicker` with a function that hands back
//     a real handle into `navigator.storage.getDirectory()`) — used here to
//     both create a genuine *source* local-workspace instance (so its
//     instance.yaml/module content is whatever the real definition/wizard
//     produces, not hand-typed YAML that could drift from the real schema)
//     and to seed extra assets/out/ files directly through the same OPFS
//     handle.
//   - the `withFakeAzureDevOpsServer` + `installBaseUrlRoutes` pattern from
//     tests/new-workspace-wizard.playwright.test.js — a real in-process fake
//     standing in for the *destination* Azure DevOps repo, so the import's
//     actual pushed file content can be read back and asserted on.
//
// This file additionally patches `FileSystemDirectoryHandle.prototype`'s
// `queryPermission`/`requestPermission` so the "lapsed permission" test can
// deterministically control the re-grant flow — real per-origin OPFS
// permission semantics are unspecified/always-granted, so a test can't rely
// on OPFS itself ever reporting anything but 'granted'.

const ORGANIZATION = 'Contoso-Production'
const PROJECT = 'Default'
const REPOSITORY = 'import-repo'

const ADVANCED_MODE_ON_INIT = `window.localStorage.setItem('gantry:advancedMode', 'true')`

const FS_MOCK_INIT = `
  window.__nextPickFiles = {}
  window.__mockPickNames = []
  window.__permissionState = 'granted'
  async function __writePath(dir, path, content) {
    const parts = path.split('/')
    const file = parts.pop()
    let d = dir
    for (const p of parts) d = await d.getDirectoryHandle(p, { create: true })
    const fh = await d.getFileHandle(file, { create: true })
    const w = await fh.createWritable()
    await w.write(content)
    await w.close()
  }
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory()
    const name = 'pick-' + Date.now() + '-' + Math.random().toString(36).slice(2)
    window.__mockPickNames.push(name)
    const dir = await root.getDirectoryHandle(name, { create: true })
    const seed = window.__nextPickFiles || {}
    for (const [p, c] of Object.entries(seed)) await __writePath(dir, p, c)
    window.__nextPickFiles = {}
    return dir
  }
  if (window.FileSystemDirectoryHandle) {
    window.FileSystemDirectoryHandle.prototype.queryPermission = async function () {
      return window.__permissionState
    }
    window.FileSystemDirectoryHandle.prototype.requestPermission = async function () {
      return window.__permissionState
    }
  }
`

function withImportTestServer(fn) {
  return withFakeAzureDevOpsServer(
    { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, validPat: VALID_PAT, files: {} },
    (adoBaseUrl) => {
      const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-import-'))
      return withRunningServer(
        { instancesDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
        async (gantryBase) => {
          try {
            await fn({ gantryBase, adoBaseUrl, instancesDir })
          } finally {
            rmSync(instancesDir, { recursive: true, force: true })
          }
        }
      )
    }
  )
}

// Injects the fake server's real `baseUrl` into the two requests the
// wizard's own forms have no field for — mirrors
// tests/new-workspace-wizard.playwright.test.js's own `installBaseUrlRoutes`
// (a subset: this file never reaches the repo-check/adopt/work-item-lookup
// routes those tests exercise).
function installBaseUrlRoutes(page, adoBaseUrl) {
  const routeWorkspaces = page.route('**/api/workspaces', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    const body = JSON.parse(route.request().postData() ?? '{}')
    body.baseUrl = adoBaseUrl
    await route.continue({ postData: JSON.stringify(body) })
  })
  const routeImport = page.route('**/api/instances/import', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    if (body.azureDevOps) body.azureDevOps.baseUrl = adoBaseUrl
    await route.continue({ postData: JSON.stringify(body) })
  })
  const routeWorkItemTypes = page.route('**/api/azure-devops/work-item-types*', async (route) => {
    const url = new URL(route.request().url())
    url.searchParams.set('baseUrl', adoBaseUrl)
    await route.continue({ url: url.toString() })
  })
  const routeWorkItemsCreate = page.route('**/api/azure-devops/work-items', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue()
      return
    }
    const body = JSON.parse(route.request().postData() ?? '{}')
    body.baseUrl = adoBaseUrl
    await route.continue({ postData: JSON.stringify(body) })
  })
  const routeWorkItemsLink = page.route('**/api/instance/work-items/link*', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}')
    body.baseUrl = adoBaseUrl
    await route.continue({ postData: JSON.stringify(body) })
  })
  return Promise.all([routeWorkspaces, routeImport, routeWorkItemTypes, routeWorkItemsCreate, routeWorkItemsLink])
}

// Creates a genuine source local-workspace instance via the wizard's own
// (already-covered, WI #295) Local + Register flow, in a fresh OPFS folder —
// real instance.yaml + blank module files, written by the same code path
// production uses, so this file never hand-types YAML that could drift from
// the real schema. Returns the instance's slug and the OPFS pick-folder name
// (for direct, out-of-band OPFS writes below).
async function createLocalSourceInstance(page, { gantryBase, workspaceName, instanceName }) {
  await page.goto(`${gantryBase}/new-workspace`)
  await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Local', exact: true }).click()
  await page.getByRole('button', { name: 'Register new local workspace', exact: true }).click()
  await page.locator('#local-register-pick').click()
  await page.waitForSelector('#local-ws-name')
  // Captured now, before "Create instance" below navigates to the editor
  // route — that navigation loads a fresh document, and FS_MOCK_INIT's
  // `page.addInitScript` re-runs on every new document, resetting
  // `window.__mockPickNames` to `[]`; the OPFS folder itself survives the
  // navigation (same origin), only this page-global bookkeeping array does
  // not.
  const folderName = await page.evaluate(() => window.__mockPickNames[window.__mockPickNames.length - 1])
  await page.locator('#local-ws-name').fill(workspaceName)
  await page.locator('#local-register-create').click()

  await page.waitForSelector('#instance-name')
  await page.locator('.definition-card').first().click()
  await page.locator('#instance-name').fill(instanceName)
  const slug = await page.locator('#instance-directory').inputValue()
  await page.locator('#instance-assignee').fill('a.architect')

  await Promise.all([
    page.waitForNavigation({ timeout: 10_000 }),
    page.getByRole('button', { name: 'Create instance', exact: true }).click(),
  ])

  // Navigate off the editor route immediately — its own load/save logic
  // (A6, #297) keeps touching this same local workspace's files
  // asynchronously in the background, which would otherwise race any direct
  // OPFS seeding a caller does next (seedExtraLocalContent below). OPFS
  // storage itself is unaffected by which page is loaded.
  await page.goto(`${gantryBase}/new-workspace`)
  await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })

  return { slug, folderName }
}

// Direct, out-of-band OPFS writes into a source local workspace's folder —
// standing in for content a real architect would have authored/uploaded
// before ever opening the import wizard: fills in one field of one module
// file with distinctive text (proving "every modules/*.md file's actual
// content" is carried over verbatim, not just a blank template), adds one
// asset file (proving assets/* is carried over), and adds a file under out/
// (proving out/ is never read at all — #305's explicit exclusion).
//
// Patches the picked module's *existing* blank-template text in place —
// same frontmatter, same module title heading, same field headings, only
// the first field's blank body gets `marker` inserted — rather than
// overwriting it with fabricated frontmatter/headings. `createLocalInstance`
// wrote genuinely valid, current-heading-scale module files (ADR-0016); a
// fabricated file whose module id/title/field headings don't match the
// destination definition's own module spec looks, to `lib/instance.js`'s
// entirely unrelated *lazy heading-scale migration* (queued on the next
// real read of a module — e.g. the gate/status check every instance listing
// performs), exactly like a genuine pre-ADR-0016 file, and gets silently
// "migrated" (rewritten) — a real gantry-authored file, old- or new-scale,
// never trips that migration in the first place, which is what this mirrors.
async function seedExtraLocalContent(page, { folderName, slug, marker, assetContent }) {
  return page.evaluate(
    async ({ folderName, slug, marker, assetContent }) => {
      const root = await navigator.storage.getDirectory()
      const dir = await root.getDirectoryHandle(folderName)
      const wsDir = await dir.getDirectoryHandle('gantry-workspace')
      const instDir = await wsDir.getDirectoryHandle(slug)

      const modulesDir = await instDir.getDirectoryHandle('modules')
      let firstModuleName = null
      for await (const [name] of modulesDir.entries()) {
        if (name.endsWith('.md')) {
          firstModuleName = name
          break
        }
      }
      const moduleFh = await modulesDir.getFileHandle(firstModuleName, { create: false })
      const original = await (await moduleFh.getFile()).text()
      // The blank template's first field section is `## <title>\n\n\n` (heading,
      // blank line, blank line) before the next heading or end of file — fill
      // its blank body with `marker`, leaving every heading untouched.
      const patched = original.replace(/^(## .+)\n\n\n/m, `$1\n\n${marker}\n\n`)
      if (patched === original) {
        throw new Error('seedExtraLocalContent: no field section matched in ' + firstModuleName)
      }
      const moduleW = await moduleFh.createWritable()
      await moduleW.write(patched)
      await moduleW.close()

      const assetsDir = await instDir.getDirectoryHandle('assets', { create: true })
      const assetFh = await assetsDir.getFileHandle('diagram.png', { create: true })
      const assetW = await assetFh.createWritable()
      await assetW.write(assetContent)
      await assetW.close()

      const outDir = await instDir.getDirectoryHandle('out', { create: true })
      const outFh = await outDir.getFileHandle('rendered.docx', { create: true })
      const outW = await outFh.createWritable()
      await outW.write('should-never-be-uploaded')
      await outW.close()

      return { moduleId: firstModuleName.slice(0, -'.md'.length), moduleText: patched }
    },
    { folderName, slug, marker, assetContent }
  )
}

async function openImportSourcePanel(page, gantryBase) {
  await page.goto(`${gantryBase}/new-workspace`)
  await page.waitForSelector('h2:has-text("New Workspace")', { timeout: 10_000 })
  await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
  await page.getByRole('button', { name: 'Import from local workspace', exact: true }).click()
}

async function pickImportInstanceFromRecent(page, { workspaceName, slug }) {
  await page.waitForSelector('#import-recent', { timeout: 10_000 })
  await page
    .locator('#import-recent .definition-card', { hasText: workspaceName })
    .getByRole('button', { name: 'Open' })
    .click()
  await page.waitForSelector('#import-instance-picker', { timeout: 10_000 })
  await page.locator('#import-instance-picker .definition-card', { hasText: slug }).click()
  await page.waitForSelector('#import-ws-organization,#import-workspace-picker', { timeout: 10_000 })
}

async function chooseNewDestination(page, { organization, project, repository }) {
  await page.waitForSelector('#import-ws-organization', { timeout: 10_000 })
  await page.locator('#import-ws-organization').fill(organization)
  await page.locator('#import-ws-project').fill(project)
  await page.locator('#import-ws-repository').fill(repository)
  await page.locator('#import-register-workspace').click()
}

async function chooseExistingDestination(page, { organization, project, repository }) {
  await page.getByRole('button', { name: 'An already-registered server workspace', exact: true }).click()
  await page.waitForSelector('#import-workspace-picker', { timeout: 10_000 })
  await page
    .locator('#import-workspace-picker .definition-card', { hasText: `${organization}/${project}/${repository}` })
    .click()
  await page.locator('#import-pick-workspace-continue').click()
}

async function completeLinkStep(page, { title }) {
  await page.getByRole('button', { name: 'Next: link a work item' }).click()
  await page.waitForSelector('#work-item-type option', { state: 'attached', timeout: 10_000 })
  await page.locator('#new-work-item-title').fill(title)
  await page.getByRole('button', { name: 'Create instance & link' }).click()
}

async function readFileOrNull(client, path) {
  try {
    return await client.getFileContent(path)
  } catch (err) {
    if (err instanceof AzureDevOpsNotFoundError) return null
    throw err
  }
}

test('Import (new destination): a local instance\'s real content lands on a populated Instance step and is written to a freshly-registered Azure DevOps workspace', async () => {
  await withImportTestServer(async ({ gantryBase, adoBaseUrl }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await page.addInitScript(FS_MOCK_INIT)
      await installBaseUrlRoutes(page, adoBaseUrl)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      await page.goto(`${gantryBase}/new-workspace`)

      const { slug, folderName } = await createLocalSourceInstance(page, {
        gantryBase,
        workspaceName: 'New-Dest Source WS',
        instanceName: 'Claims New Dest',
      })

      const { moduleId: firstModuleId, moduleText } = await seedExtraLocalContent(page, {
        folderName,
        slug,
        marker: 'HELLO-IMPORTED-CONTENT',
        assetContent: 'not-real-png-bytes',
      })

      await openImportSourcePanel(page, gantryBase)
      await pickImportInstanceFromRecent(page, { workspaceName: 'New-Dest Source WS', slug })

      // Destination: brand-new server workspace.
      await chooseNewDestination(page, { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY })

      // Landed on a populated Instance step — not blank.
      await page.waitForSelector('#instance-name', { timeout: 10_000 })
      assert.equal(await page.locator('#instance-name').inputValue(), slug)
      assert.equal(await page.locator('#instance-directory').inputValue(), slug)
      assert.equal(await page.locator('#instance-assignee').inputValue(), 'a.architect')
      assert.match(
        await page.locator('.definition-card.selected .name').textContent(),
        /./,
        'a definition card is pre-selected from the imported instance.yaml'
      )

      await completeLinkStep(page, { title: 'Import parent work item' })
      await page.waitForSelector('text=Instance created', { timeout: 10_000 })

      // The registry has the new instance.
      const registryRes = await fetch(`${gantryBase}/api/instances`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
      const registry = await registryRes.json()
      assert.ok(registry.some((i) => i.slug === slug), 'the imported instance is registered')

      // The real imported content, not blank templates, was pushed to the
      // destination repo.
      const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
      const instanceYaml = await client.getFileContent(`gantry-workspace/${slug}/instance.yaml`)
      assert.match(instanceYaml, new RegExp(`slug: ${slug}`))
      assert.match(instanceYaml, /assignee: a\.architect/)
      assert.match(instanceYaml, /definitionVersion: \d+/)

      const pushedModule = await client.getFileContent(`gantry-workspace/${slug}/modules/${firstModuleId}.md`)
      assert.equal(pushedModule, moduleText, 'the module file was pushed byte-for-byte, not re-rendered blank')

      const pushedAsset = await client.getFileContent(`gantry-workspace/${slug}/assets/diagram.png`)
      assert.equal(pushedAsset, Buffer.from('not-real-png-bytes', 'utf8').toString('base64'), 'the asset was pushed as base64-encoded content')

      const pushedOut = await readFileOrNull(client, `gantry-workspace/${slug}/out/rendered.docx`)
      assert.equal(pushedOut, null, 'out/ is never uploaded as part of import')

      // Opt-in forget prompt is present but not yet acted on — decline it,
      // and confirm the source workspace stays remembered either way.
      await page.waitForSelector('#import-forget-prompt', { timeout: 10_000 })
      assert.match(
        await page.locator('#import-forget-prompt').textContent(),
        /Nothing on disk is deleted/
      )
      await page.locator('#import-forget-no').click()
      await page.waitForSelector('#import-forget-prompt', { state: 'detached', timeout: 10_000 })
      assert.equal(await page.locator('#import-forgotten-notice').count(), 0)

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

test('Import (existing destination): a second import lands in the already-registered workspace, and the opt-in forget prompt actually forgets the source', async () => {
  await withImportTestServer(async ({ gantryBase, adoBaseUrl }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await page.addInitScript(FS_MOCK_INIT)
      await installBaseUrlRoutes(page, adoBaseUrl)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      await page.goto(`${gantryBase}/new-workspace`)

      // First import registers the destination workspace.
      const first = await createLocalSourceInstance(page, {
        gantryBase,
        workspaceName: 'Existing-Dest Source A',
        instanceName: 'First Import',
      })
      await openImportSourcePanel(page, gantryBase)
      await pickImportInstanceFromRecent(page, { workspaceName: 'Existing-Dest Source A', slug: first.slug })
      await chooseNewDestination(page, { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY })
      await page.waitForSelector('#instance-name', { timeout: 10_000 })
      await completeLinkStep(page, { title: 'First parent work item' })
      await page.waitForSelector('text=Instance created', { timeout: 10_000 })
      await page.locator('#import-forget-no').click()

      // Second import (a different local workspace, different slug) picks
      // the now-already-registered destination workspace instead of
      // registering another one.
      const second = await createLocalSourceInstance(page, {
        gantryBase,
        workspaceName: 'Existing-Dest Source B',
        instanceName: 'Second Import',
      })
      await openImportSourcePanel(page, gantryBase)
      await pickImportInstanceFromRecent(page, { workspaceName: 'Existing-Dest Source B', slug: second.slug })
      await chooseExistingDestination(page, { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY })

      await page.waitForSelector('#instance-name', { timeout: 10_000 })
      assert.equal(await page.locator('#instance-name').inputValue(), second.slug)
      await completeLinkStep(page, { title: 'Second parent work item' })
      await page.waitForSelector('text=Instance created', { timeout: 10_000 })

      // Both instances registered, sharing the exact same workspace — no
      // duplicate workspace was registered for the second, picked pass.
      const registry = await (
        await fetch(`${gantryBase}/api/instances`, { headers: { Authorization: basicAuthHeader(VALID_PAT) } })
      ).json()
      assert.ok(registry.some((i) => i.slug === first.slug))
      assert.ok(registry.some((i) => i.slug === second.slug))
      const workspaces = await (await fetch(`${gantryBase}/api/workspaces`)).json()
      assert.equal(workspaces.filter((w) => w.repository === REPOSITORY).length, 1)

      // Opt-in this time — the source local workspace is actually forgotten.
      await page.waitForSelector('#import-forget-prompt', { timeout: 10_000 })
      await page.locator('#import-forget-yes').click()
      await page.waitForSelector('#import-forgotten-notice', { timeout: 10_000 })
      assert.match(
        await page.locator('#import-forgotten-notice').textContent(),
        /untouched/
      )

      // Confirm it is genuinely gone from this browser's remembered list —
      // re-open the source picker and it's no longer offered — while its
      // sibling (declined) local workspace is still there.
      await openImportSourcePanel(page, gantryBase)
      await page.waitForSelector('#import-recent', { timeout: 10_000 })
      const recentNames = await page.locator('#import-recent .definition-card .name').allTextContents()
      assert.ok(!recentNames.includes('Existing-Dest Source B'), 'the forgotten workspace no longer appears in the recent list')
      assert.ok(recentNames.includes('Existing-Dest Source A'), 'the declined workspace is still remembered')
    } finally {
      await browser.close()
    }
  })
})

test('Import: a slug already in use at the destination is rejected, not silently overwritten', async () => {
  await withImportTestServer(async ({ gantryBase, adoBaseUrl }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await page.addInitScript(FS_MOCK_INIT)
      await installBaseUrlRoutes(page, adoBaseUrl)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      await page.goto(`${gantryBase}/new-workspace`)

      // First import claims the slug at the destination.
      const first = await createLocalSourceInstance(page, {
        gantryBase,
        workspaceName: 'Collision Source A',
        instanceName: 'Collide',
      })
      await openImportSourcePanel(page, gantryBase)
      await pickImportInstanceFromRecent(page, { workspaceName: 'Collision Source A', slug: first.slug })
      await chooseNewDestination(page, { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY })
      await page.waitForSelector('#instance-name', { timeout: 10_000 })
      await completeLinkStep(page, { title: 'Collision parent work item' })
      await page.waitForSelector('text=Instance created', { timeout: 10_000 })
      await page.locator('#import-forget-no').click()

      // A second, independent local instance that resolves to the exact
      // same slug ("collide") tries to import into the same destination
      // repo — rejected, never a silent overwrite.
      const second = await createLocalSourceInstance(page, {
        gantryBase,
        workspaceName: 'Collision Source B',
        instanceName: 'Collide',
      })
      assert.equal(second.slug, first.slug, 'both local instances resolve to the same slug')
      await openImportSourcePanel(page, gantryBase)
      await pickImportInstanceFromRecent(page, { workspaceName: 'Collision Source B', slug: second.slug })
      await chooseExistingDestination(page, { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY })
      await page.waitForSelector('#instance-name', { timeout: 10_000 })
      await completeLinkStep(page, { title: 'Second collision parent work item' })

      await page.waitForSelector('.inline-error', { timeout: 10_000 })
      assert.match(await page.locator('.inline-error').first().textContent(), /already exists/i)
      // Never reached the Done step.
      assert.equal(await page.locator('text=Instance created').count(), 0)

      // The original import's content is untouched — still readable and
      // still whatever the first import actually wrote.
      const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
      const instanceYaml = await client.getFileContent(`gantry-workspace/${first.slug}/instance.yaml`)
      assert.match(instanceYaml, new RegExp(`slug: ${first.slug}`))
    } finally {
      await browser.close()
    }
  })
})

test('Import: a lapsed local-handle permission shows "Grant access", and granting it recovers the source picker', async () => {
  await withImportTestServer(async ({ gantryBase, adoBaseUrl }) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.addInitScript(ADVANCED_MODE_ON_INIT)
      await page.addInitScript(FS_MOCK_INIT)
      await installBaseUrlRoutes(page, adoBaseUrl)
      await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)

      await page.goto(`${gantryBase}/new-workspace`)

      const { slug } = await createLocalSourceInstance(page, {
        gantryBase,
        workspaceName: 'Lapsed Permission Source',
        instanceName: 'Lapsed Claims',
      })

      await openImportSourcePanel(page, gantryBase)
      await page.waitForSelector('#import-recent', { timeout: 10_000 })

      // The remembered handle's permission has lapsed (e.g. a new browser
      // session) — clicking "Open" surfaces "Grant access" instead of the
      // instance list.
      await page.evaluate(() => {
        window.__permissionState = 'prompt'
      })
      await page
        .locator('#import-recent .definition-card', { hasText: 'Lapsed Permission Source' })
        .getByRole('button', { name: 'Open' })
        .click()
      await page.waitForSelector('#import-recent .definition-card button:has-text("Grant access")', { timeout: 10_000 })
      assert.equal(await page.locator('#import-instance-picker').count(), 0, 'the instance list has not loaded yet')

      // The architect grants access (the real native permission dialog, here
      // simulated by flipping the mocked permission state) and clicks
      // "Grant access" — the same recent-workspace entry now opens normally.
      await page.evaluate(() => {
        window.__permissionState = 'granted'
      })
      await page
        .locator('#import-recent .definition-card', { hasText: 'Lapsed Permission Source' })
        .getByRole('button', { name: 'Grant access' })
        .click()
      await page.waitForSelector('#import-instance-picker', { timeout: 10_000 })
      assert.deepEqual(
        await page.locator('#import-instance-picker .definition-card .name').allTextContents(),
        [slug]
      )

      // The recovered flow completes a real import end to end.
      await page.locator('#import-instance-picker .definition-card', { hasText: slug }).click()
      await chooseNewDestination(page, { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY })
      await page.waitForSelector('#instance-name', { timeout: 10_000 })
      await completeLinkStep(page, { title: 'Lapsed permission parent work item' })
      await page.waitForSelector('text=Instance created', { timeout: 10_000 })

      const client = createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: VALID_PAT, baseUrl: adoBaseUrl })
      const instanceYaml = await client.getFileContent(`gantry-workspace/${slug}/instance.yaml`)
      assert.match(instanceYaml, new RegExp(`slug: ${slug}`))
    } finally {
      await browser.close()
    }
  })
})

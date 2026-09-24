import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, cpSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer, withScratchInstances, ORGANIZATION, PROJECT, REPOSITORY, VALID_PAT } from './helpers/lifecycle.js'
import { withFakeAzureDevOpsServer } from './helpers/fakeAzureDevOpsServer.js'
import { loadDefinition } from '../lib/definition.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { resolveStageBranch } from '../lib/stageBranch.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'

// #151 (ADR-0051): an Artefact's "counts toward the gate" switch in the browser — the Definitions
// page's checkbox (ticked by default; unticking writes `satisfies-gate: false`, which survives save,
// reload and publish), the unsatisfiable-gate marker when every Artefact at a gate is unticked, the
// Local Workspace editor's twin checkbox, and the instance editor's hint beside an Artefact that
// doesn't count, with a gate check that names the Artefact that does.

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    page.on('dialog', (d) => d.accept())
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()) })
    await fn(page)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

// A draft v2 copy of the design Definition, as tests/documentControlCheckbox.playwright.test.js sets up.
async function withDraftDesignV2(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-satisfies-gate-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-satisfies-gate-'))
  try {
    cpSync('definitions/design/1', join(definitionsDir, 'design/1'), { recursive: true })
    cpSync(join(definitionsDir, 'design/1'), join(definitionsDir, 'design/2'), { recursive: true })
    const yamlPath = join(definitionsDir, 'design/2/definition.yaml')
    writeFileSync(yamlPath, readFileSync(yamlPath, 'utf8').replace('version: 1', 'version: 2').replace('status: published', 'status: draft'))
    await withRunningServer({ definitionsDir, instancesDir }, (base) => fn(base, definitionsDir))
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

function artefactOnDisk(definitionsDir, artefactId) {
  const raw = parseYAML(readFileSync(join(definitionsDir, 'design/2/definition.yaml'), 'utf8'))
  return raw.artefacts.find((a) => a.id === artefactId)
}

// Opens design v2 and focuses the named Artefact, waiting for its checkbox to render.
async function openArtefact(page, base, title) {
  await page.goto(`${base}/definitions`)
  await page.waitForSelector('#defn-version-select', { timeout: 10_000 })
  await page.locator('#defn-version-select').selectOption('2')
  await page.waitForSelector('.defn-outline', { timeout: 10_000 })
  const artefactNode = page.locator('.defn-outline-group').nth(1).locator('.defn-outline-node').filter({ hasText: title }).first()
  await artefactNode.waitFor({ state: 'visible', timeout: 10_000 })
  await artefactNode.click()
  const checkbox = page.locator('.defn-satisfies-gate input[type="checkbox"]')
  await checkbox.waitFor({ state: 'visible', timeout: 10_000 })
  return checkbox
}

test('Definitions page: unticking an Artefact\'s "passes its gate" box writes satisfies-gate: false, which survives save, reload and publish; unticking every Artefact at a gate is marked', async () => {
  await withDraftDesignV2(async (base, definitionsDir) => {
    await withPage(async (page) => {
      // The SAD and the SSAD share the Build-ready Checklist gate.
      let checkbox = await openArtefact(page, base, 'Solution Support Architecture Document')
      assert.equal(await checkbox.isChecked(), true, 'ticked by default — the Artefact counts')
      assert.equal(await checkbox.isDisabled(), false, 'editable on a draft')
      await checkbox.uncheck()
      await page.waitForSelector('.defn-no-problems', { timeout: 10_000 })

      // Unticking the SAD too leaves nothing that can pass the gate: marked on the Stage, then cleared.
      const sad = page.locator('.defn-outline-group').nth(1).locator('.defn-outline-node').filter({ hasText: 'Solution Architecture Document' }).first()
      await sad.click()
      await checkbox.waitFor({ state: 'visible', timeout: 10_000 })
      await checkbox.uncheck()
      await page.locator('.defn-problems', { hasText: /1 problem\b/ }).waitFor({ state: 'visible', timeout: 10_000 })
      const stageRow = page.locator('.defn-outline-group').nth(0).locator('.defn-outline-node').filter({ has: page.locator('.defn-problem-dot') })
      assert.equal(await stageRow.count(), 1, 'the problem is anchored on the Stage')
      await checkbox.check()
      await page.waitForSelector('.defn-no-problems', { timeout: 10_000 })

      const saved = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/api/definitions/design/versions/2'), { timeout: 10_000 })
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      assert.equal((await saved).status(), 200)
      assert.equal(artefactOnDisk(definitionsDir, 'ssad')['satisfies-gate'], false)
      assert.equal(artefactOnDisk(definitionsDir, 'sad')['satisfies-gate'], undefined, 're-ticking drops the key')

      await page.reload()
      checkbox = await openArtefact(page, base, 'Solution Support Architecture Document')
      assert.equal(await checkbox.isChecked(), false, 'the opt-out survives a reload')

      await page.getByRole('button', { name: 'Publish', exact: true }).click()
      await page.waitForSelector('.stamp.agreed', { timeout: 10_000 })
      assert.equal(artefactOnDisk(definitionsDir, 'ssad')['satisfies-gate'], false, 'the opt-out survives publish')

      checkbox = await openArtefact(page, base, 'Solution Support Architecture Document')
      assert.equal(await checkbox.isChecked(), false)
      assert.equal(await checkbox.isDisabled(), true, 'read-only on a published version')
    })
  })
})

// The Local Workspace twin (/definitions/local), seeded through OPFS the way
// tests/documentControlCheckbox.playwright.test.js does.
test('Local Workspace editor: unticking an Artefact\'s "passes its gate" box saves satisfies-gate: false to the workspace\'s own folder', async () => {
  await withRunningServer({}, async (base) => {
    await withPage(async (page) => {
      await page.goto(`${base}/`)
      const workspaceId = await page.evaluate(async () => {
        const { rememberWorkspace } = await import('/lib/localWorkspace.js')
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('local-ws-satisfies-gate-' + Date.now(), { create: true })
        return rememberWorkspace({ handle: dir, name: 'Satisfies Gate E2E Workspace' })
      })
      const readDefinitionYaml = () => page.evaluate(async (workspaceId) => {
        const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
        return readTextFile(await getWorkspaceHandle(workspaceId), 'definitions/satisfies-gate-local-e2e/1/definition.yaml')
      }, workspaceId)

      await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('#local-def-id')
      await page.locator('#local-def-id').fill('satisfies-gate-local-e2e')
      await page.locator('#local-def-title').fill('Satisfies Gate Local E2E')
      await page.getByRole('button', { name: 'Create', exact: true }).click()

      await page.waitForSelector('.local-definition-editor')
      const editorRoot = page.locator('.local-definition-editor')
      const artefactsSection = editorRoot.locator('section').filter({ has: page.locator('h2', { hasText: 'Artefacts' }) })
      await artefactsSection.getByRole('button', { name: '+ Add artefact' }).click()
      const artefactEl = artefactsSection.locator('.local-def-element').first()
      await artefactEl.locator('input[type="text"]').nth(0).fill('offer-pack')
      await artefactEl.locator('input[type="text"]').nth(1).fill('Offer Pack')

      const checkbox = artefactEl.locator('.defn-satisfies-gate input[type="checkbox"]')
      await checkbox.waitFor({ state: 'visible', timeout: 5_000 })
      assert.equal(await checkbox.isChecked(), true)
      await checkbox.uncheck()

      await editorRoot.locator('> .detail-actions').getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForSelector('.local-definition-editor > .detail-actions .save-status:has-text("Saved.")', { timeout: 5_000 })
      assert.equal(parseYAML(await readDefinitionYaml()).artefacts[0]['satisfies-gate'], false)
    })
  })
})

// recruitment-onboarding v2's Appointment gate has the Appointment Case and the Offer Pack. With the
// Offer Pack opted out and the vetting record missing (which only the Appointment Case needs), the
// Offer Pack is complete but the gate still fails — and says it's the Appointment Case that's short.
test('instance editor: an Artefact that doesn\'t count toward the gate is hinted in the selector, and the gate check names the one that does', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-satisfies-gate-instance-'))
  try {
    cpSync('definitions/recruitment-onboarding', join(definitionsDir, 'recruitment-onboarding'), { recursive: true })
    const yamlPath = join(definitionsDir, 'recruitment-onboarding', '2', 'definition.yaml')
    const yaml = readFileSync(yamlPath, 'utf8')
    const optedOut = yaml.replace('    template: templates/offer-pack.md.tmpl\n', '    template: templates/offer-pack.md.tmpl\n    satisfies-gate: false\n')
    assert.notEqual(optedOut, yaml, 'the fixture edit must land')
    writeFileSync(yamlPath, optedOut)

    await withScratchInstances(async (instancesDir) => {
      // The worked hire as it stood on v2 (#186 moved the example itself to v3).
      cpSync('tests/fixtures/recruitment-onboarding-v2/platform-engineer', join(instancesDir, 'platform-engineer'), { recursive: true })
      rmSync(join(instancesDir, 'platform-engineer', 'modules', 'vetting.md'))
      const instanceYaml = join(instancesDir, 'platform-engineer', 'instance.yaml')
      writeFileSync(instanceYaml, readFileSync(instanceYaml, 'utf8').replace('stage: provisioning', 'stage: appointment'))

      await withRunningServer({ slug: 'platform-engineer', instancesDir, definitionsDir }, async (base) => {
        await withPage(async (page) => {
          await page.goto(`${base}/instance/platform-engineer`)
          const selector = page.locator('.artefact-selector')
          await selector.waitFor({ state: 'visible', timeout: 10_000 })

          await selector.getByRole('button', { name: /^Artefact:/ }).click()
          const offerPack = selector.getByRole('menuitemradio', { name: /Offer Pack/ })
          await offerPack.waitFor({ state: 'visible', timeout: 5_000 })
          assert.match(await offerPack.textContent(), /doesn't count toward the gate/)
          assert.doesNotMatch(await selector.getByRole('menuitemradio', { name: /Appointment Case/ }).textContent(), /count toward/)
          await offerPack.click()
          await selector.locator('.artefact-gate-hint', { hasText: "Doesn't count toward the gate" }).waitFor({ state: 'visible', timeout: 5_000 })

          const panel = page.locator('.advance-stage-panel')
          await panel.getByRole('button', { name: 'Advance to next stage' }).click()
          await panel.locator('text=FAIL').waitFor({ timeout: 10_000 })
          assert.match(await panel.textContent(), /FAIL — Appointment Case: Vetting \(file missing\)/)
          assert.equal(await page.locator('.modal[aria-label="Confirm stage advancement"]').count(), 0)
        })
      })
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
  }
})

// The Work Item Detail card's sign-off panel (`.signoff-section`, web/app.js's own
// `formatGateFailure` — the Workspace-backed counterpart to this file's advance-stage-panel
// coverage above) shares the same failure text, but only a Workspace-backed instance renders
// that panel at all (tests/stageApproval.playwright.test.js), so this drives it against a fake
// Azure DevOps server rather than a local instance.
test('the sign-off panel: a failing gate check names the closest Artefact that counts toward it, never one that doesn\'t', async () => {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-satisfies-gate-signoff-'))
  try {
    cpSync('definitions/recruitment-onboarding', join(definitionsDir, 'recruitment-onboarding'), { recursive: true })
    const yamlPath = join(definitionsDir, 'recruitment-onboarding', '2', 'definition.yaml')
    const yaml = readFileSync(yamlPath, 'utf8')
    const optedOut = yaml.replace('    template: templates/offer-pack.md.tmpl\n', '    template: templates/offer-pack.md.tmpl\n    satisfies-gate: false\n')
    assert.notEqual(optedOut, yaml, 'the fixture edit must land')
    writeFileSync(yamlPath, optedOut)
    const definition = loadDefinition('recruitment-onboarding', { definitionsDir, version: 2 })

    const SLUG = 'platform-engineer'
    const location = { organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY }
    const files = { [`/gantry-workspace/${SLUG}/instance.yaml`]: `definition: recruitment-onboarding\nslug: ${SLUG}\nstage: appointment\ndefinitionVersion: 2\n` }

    await withFakeAzureDevOpsServer({ ...location, validPat: VALID_PAT, files }, async (adoBaseUrl) => {
      await withScratchInstances(async (instancesDir) => {
        registerInstance(SLUG, { kind: 'azureDevOps', ...location, baseUrl: adoBaseUrl }, { instancesDir })
        const azureDevOps = { ...location, pat: VALID_PAT, baseUrl: adoBaseUrl }
        const branch = await resolveStageBranch(azureDevOps, definition, SLUG, 'appointment')
        const client = createAzureDevOpsClient(azureDevOps)
        // Leave out vetting.md (only the Appointment Case needs it) and payroll.md (both need
        // it), so the Offer Pack is one module short and the Appointment Case two — the Offer
        // Pack is the *closer* miss, but it doesn't count toward the gate, so the message must
        // still name the Appointment Case.
        const modulesDir = 'workspaces/examples/platform-engineer/modules'
        for (const name of readdirSync(modulesDir)) {
          if (name === 'vetting.md' || name === 'payroll.md') continue
          await client.writeFile(`gantry-workspace/${SLUG}/modules/${name}`, readFileSync(join(modulesDir, name), 'utf8'), { branch })
        }

        await withRunningServer(
          { instancesDir, definitionsDir, allowedAzureDevOpsBaseUrls: [adoBaseUrl], allowAzureDevOpsBaseUrlOverride: true },
          async (base) => {
            await withPage(async (page) => {
              await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), VALID_PAT)
              // #301 — the Work item details card renders only while advanced mode is on.
              await page.addInitScript(() => localStorage.setItem('gantry:advancedMode', 'true'))

              await page.goto(`${base}/instance/${SLUG}`)
              await page.waitForSelector('.signoff-section', { timeout: 10_000 })
              const panel = page.locator('.signoff-section')

              await panel.getByRole('button', { name: 'Request Sign-off' }).click()
              await panel.locator('text=FAIL').waitFor({ timeout: 10_000 })
              const text = await panel.textContent()
              assert.match(text, /FAIL — Appointment Case: Vetting \(file missing\), Payroll \(file missing\)/)
              assert.doesNotMatch(text, /Offer Pack/)
              assert.equal(await page.locator('.modal[aria-label="Confirm request sign-off"]').count(), 0)
            })
          }
        )
      })
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
  }
})

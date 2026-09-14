import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// Browser test for WI #384 (Definition Editor phase 4, parent Feature #380):
// a local-workspace definition, created/edited/published entirely through
// the File System Access API (`web/pages/local-definition-editor.js`,
// `web/lib/localDefinitionFiles.js`), then pinned by a local-workspace
// instance (the "+ New Instance" wizard's Instance step, WI #384 item 4) and
// actually used — gate-checked, rendered and advanced — proving the whole
// round trip end to end against a real (OPFS-backed) directory handle.
//
// The File System Access API is not driveable from a headless test browser
// (see tests/wizard-local-workspace.playwright.test.js's own doc comment on
// why), so this seeds a real directory in the Origin Private File System
// (`navigator.storage.getDirectory()`) directly via the app's own
// `web/lib/localWorkspace.js` (dynamic-imported in-page) and remembers it
// with `rememberWorkspace`, the exact convention
// tests/editor-local-workspace.playwright.test.js already established —
// then drives every subsequent step (create/edit/publish the definition,
// pick it in the wizard, edit/check/render/advance the instance) through
// the real UI, no shortcuts past the code this ticket added.
//
// The stateless-endpoint half of this same scope (an inline `definition` on
// /api/local/{status,check,render,compile}, and the new
// POST /api/local/definition/validate route) is covered directly, with no
// browser at all, by tests/serverDefinitionEditorPhase4.test.js; the pure
// read/write file-format half by tests/localDefinitionFiles.test.js. This
// spec is the one place all three meet, through the actual editor and
// wizard UI.

async function rememberBareLocalWorkspace(page, name) {
  return page.evaluate(async (name) => {
    const { rememberWorkspace } = await import('/lib/localWorkspace.js')
    const root = await navigator.storage.getDirectory()
    const dir = await root.getDirectoryHandle('local-ws-' + Date.now() + '-' + Math.random().toString(36).slice(2), {
      create: true,
    })
    return rememberWorkspace({ handle: dir, name })
  }, name)
}

// Reads one file back off the remembered workspace's own OPFS handle — same
// approach tests/editor-local-workspace.playwright.test.js's own
// `readOpfsFile` uses, duplicated here per this test suite's established
// "no shared browser-side test helper module" convention.
async function readOpfsFile(page, workspaceId, path) {
  return page.evaluate(
    async ({ workspaceId, path }) => {
      const { getWorkspaceHandle, readTextFile } = await import('/lib/localWorkspace.js')
      const handle = await getWorkspaceHandle(workspaceId)
      return readTextFile(handle, path)
    },
    { workspaceId, path }
  )
}

async function listOpfsDir(page, workspaceId, path) {
  return page.evaluate(
    async ({ workspaceId, path }) => {
      const { getWorkspaceHandle, listDir } = await import('/lib/localWorkspace.js')
      const handle = await getWorkspaceHandle(workspaceId)
      return listDir(handle, path).catch(() => [])
    },
    { workspaceId, path }
  )
}

test('local-workspace definition: create, edit and publish through /definitions/local, then a local instance pins it, edits, gate-checks, renders and advances', async () => {
  await withRunningServer({}, async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))

      // Navigate first so OPFS/IndexedDB have a real http(s) origin, then seed a bare
      // local workspace — no gantry-workspace/ content at all yet, exactly the state a
      // freshly-registered local workspace is in before this ticket's own "Local
      // definitions" link has ever been used.
      await page.goto(`${base}/`)
      const workspaceId = await rememberBareLocalWorkspace(page, 'WI384 E2E Workspace')
      assert.ok(workspaceId, 'seeded a bare local workspace id')

      // ---------------------------------------------------------------
      // Create, via the CreateDefinitionForm at /definitions/local?ws=<id>
      // ---------------------------------------------------------------
      await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('#local-def-id')
      await page.locator('#local-def-id').fill('e2e-local-def')
      await page.locator('#local-def-title').fill('E2E Local Def')
      await page.getByRole('button', { name: 'Create', exact: true }).click()

      // ---------------------------------------------------------------
      // Edit: two stages (so the Advance panel below has somewhere to go), one
      // module with a required field, one artefact requiring it — a minimal but
      // real, gate-passable, renderable definition.
      // ---------------------------------------------------------------
      await page.waitForSelector('.local-definition-editor')
      const editorRoot = page.locator('.local-definition-editor')
      const stagesSection = editorRoot.locator('section').filter({ has: page.locator('h2', { hasText: 'Stages' }) })
      const modulesSection = editorRoot.locator('section').filter({ has: page.locator('h2', { hasText: 'Modules' }) })
      const artefactsSection = editorRoot.locator('section').filter({ has: page.locator('h2', { hasText: 'Artefacts' }) })

      await stagesSection.getByRole('button', { name: '+ Add stage' }).click()
      const stage1 = stagesSection.locator('.local-def-element').nth(0)
      await stage1.locator('input').nth(0).fill('shape')
      await stage1.locator('input').nth(1).fill('Shape')
      await stage1.locator('select').selectOption('business-case')
      await stage1.locator('input').nth(2).fill('Shape the idea')

      await stagesSection.getByRole('button', { name: '+ Add stage' }).click()
      const stage2 = stagesSection.locator('.local-def-element').nth(1)
      await stage2.locator('input').nth(0).fill('design-stage')
      await stage2.locator('input').nth(1).fill('Design')
      await stage2.locator('select').selectOption('design-review')
      await stage2.locator('input').nth(2).fill('Design it')

      await modulesSection.getByRole('button', { name: '+ Add module' }).click()
      const moduleEl = modulesSection.locator('.local-def-element').first()
      await moduleEl.locator('input').nth(0).fill('background')
      await moduleEl.locator('input').nth(1).fill('Background')
      await moduleEl.locator('input').nth(2).fill('Why this exists')
      await moduleEl.getByRole('button', { name: '+ Add field' }).click()
      const fieldRow = moduleEl.locator('.local-def-field-row').first()
      await fieldRow.locator('input').nth(0).fill('summary')
      await fieldRow.locator('input').nth(1).fill('Summary')
      await fieldRow.locator('select').selectOption('markdown')
      await fieldRow.locator('input[type="checkbox"]').check()

      // Stage 1's own module membership — the field just created above.
      await stage1.locator('input').nth(3).fill('background')

      await artefactsSection.getByRole('button', { name: '+ Add artefact' }).click()
      const artefactEl = artefactsSection.locator('.local-def-element').first()
      await artefactEl.locator('input').nth(0).fill('soap')
      await artefactEl.locator('input').nth(1).fill('SOAP')
      await artefactEl.locator('select').selectOption('business-case')
      await artefactEl.locator('input').nth(2).fill('Summarise')
      await artefactEl.locator('input').nth(3).fill('background.summary')
      await artefactEl.getByRole('button', { name: 'Edit template' }).click()
      await artefactEl
        .locator('.local-def-template-source')
        .fill('# <%= it.instance.definition %>\n\n<%= it.modules.background.summary %>\n')
      await artefactEl.getByRole('button', { name: 'Save template' }).click()
      await artefactEl.locator('.local-def-template .save-status:has-text("Saved.")').waitFor({ timeout: 5_000 })

      // The structure is now internally consistent — every stage/artefact module
      // reference resolves, every field type is known — so the stateless
      // POST /api/local/definition/validate round trip this page runs on every edit
      // reports it clean.
      await page.waitForSelector('.local-def-validation p.save-status:has-text("No problems found.")', { timeout: 10_000 })

      // ---------------------------------------------------------------
      // Save, then Publish.
      // ---------------------------------------------------------------
      await editorRoot.locator('> .detail-actions').getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForSelector('.local-definition-editor > .detail-actions .save-status:has-text("Saved.")', { timeout: 5_000 })

      await editorRoot.locator('> .detail-actions').getByRole('button', { name: 'Publish', exact: true }).click()
      await page.waitForSelector('.local-definition-editor > .detail-actions .save-status:has-text("Published")', { timeout: 5_000 })

      // Every field is read-only once published — no further edits possible.
      assert.notEqual(await page.locator('#local-def-title-input').getAttribute('readonly'), null)

      // ---------------------------------------------------------------
      // The files really are on disk, in the exact shape the stateless
      // endpoints/loadLocalInstance below will read back.
      // ---------------------------------------------------------------
      const definitionYaml = await readOpfsFile(page, workspaceId, 'definitions/e2e-local-def/1/definition.yaml')
      assert.match(definitionYaml, /status: published/)
      assert.match(definitionYaml, /id: shape/)
      assert.match(definitionYaml, /id: design-stage/)
      const moduleYaml = await readOpfsFile(page, workspaceId, 'definitions/e2e-local-def/1/modules/background.yaml')
      assert.match(moduleYaml, /id: summary/)
      assert.match(moduleYaml, /required: true/)
      const templateText = await readOpfsFile(page, workspaceId, 'definitions/e2e-local-def/1/templates/soap.md.tmpl')
      assert.match(templateText, /it\.modules\.background\.summary/)

      // ---------------------------------------------------------------
      // WI #384 item 4: a local-workspace instance pins this local-workspace
      // definition, via the same "+ New Instance" wizard a library definition
      // uses — the local def shows up in its own picker, tagged and all.
      // ---------------------------------------------------------------
      await page.goto(`${base}/new-workspace?local=${encodeURIComponent(workspaceId)}`)
      await page.waitForSelector('#instance-name')
      const localDefCard = page.locator('.definition-card', { hasText: 'e2e-local-def' })
      await localDefCard.waitFor({ timeout: 10_000 })
      await localDefCard.click()
      await page.locator('#instance-name').fill('E2E Local Instance')
      const slug = await page.locator('#instance-directory').inputValue()
      assert.equal(slug, 'e2e-local-instance')
      await page.locator('#instance-assignee').fill('a.architect')

      await Promise.all([
        page.waitForNavigation(),
        page.getByRole('button', { name: 'Create instance', exact: true }).click(),
      ])
      const url = new URL(page.url())
      assert.equal(url.pathname, `/instance/${slug}`)
      assert.equal(url.searchParams.get('local'), workspaceId)

      // instance.yaml pins the local-workspace definition, indistinguishable on
      // disk from pinning a library one — no separate "home" marker (WI #384's
      // own design: an id can only ever live in one place).
      const instanceYaml = await readOpfsFile(page, workspaceId, `gantry-workspace/${slug}/instance.yaml`)
      assert.match(instanceYaml, /definition: e2e-local-def/)
      assert.match(instanceYaml, /stage: shape/)

      // ---------------------------------------------------------------
      // Instance use: the module editor loads the definition straight off this
      // workspace's own definitions/ folder (never 404ing against the server
      // library, which has never heard of "e2e-local-def") — edit the one
      // required field, save, gate-check + advance, and render, exercising every
      // local render/gate-check path this ticket extended.
      // ---------------------------------------------------------------
      await page.waitForSelector('.module', { timeout: 10_000 })
      const summaryField = page.locator('.field-markdown .cm-content').first()
      await summaryField.click()
      await page.keyboard.type('The project summary.')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await page.waitForSelector('.save-status:has-text("Saved")', { timeout: 5_000 })

      const backgroundOnDisk = await readOpfsFile(page, workspaceId, `gantry-workspace/${slug}/modules/background.md`)
      assert.match(backgroundOnDisk, /The project summary\./)

      // Render — the stateless /api/local/render round trip, carrying this
      // local-workspace definition's own structure/template/reference-doc content
      // inline (buildInlineLocalDefinitionPayload, web/app.js) since the server has
      // never seen "e2e-local-def" in its own bundled definitionsDir.
      await page.getByRole('button', { name: 'Render', exact: true }).click()
      const renderDialog = page.locator('.modal[aria-label="Render an artefact"]')
      await renderDialog.waitFor({ state: 'visible', timeout: 5_000 })
      await renderDialog.getByRole('button', { name: 'SOAP', exact: true }).click()
      await renderDialog.locator('.modal-actions').getByRole('button', { name: 'Render' }).click()
      await page.waitForFunction(
        () => /rendered to|render failed/.test(document.querySelector('.modal[aria-label="Render an artefact"]')?.textContent ?? ''),
        { timeout: 20_000 }
      )
      const renderStatusText = await renderDialog.textContent()
      assert.doesNotMatch(renderStatusText, /render failed/, `render must not fail: ${renderStatusText}`)
      await page.keyboard.press('Escape')
      await renderDialog.waitFor({ state: 'hidden', timeout: 5_000 })

      const outEntries = await listOpfsDir(page, workspaceId, `gantry-workspace/${slug}/out`)
      assert.ok(outEntries.some((e) => e.name.endsWith('.docx')), `expected a rendered .docx in out/, got: ${outEntries.map((e) => e.name).join(', ')}`)

      // Gate check + Advance — checkLocalGate (client-side) evaluated against
      // this local-workspace definition's own structure, pass, advancing past the
      // "shape" stage this two-stage definition offers.
      const advancePanel = page.locator('.advance-stage-panel')
      await advancePanel.waitFor({ state: 'visible', timeout: 5_000 })
      await advancePanel.getByRole('button', { name: 'Advance to next stage' }).click()
      await page.waitForSelector('.modal[aria-label="Confirm stage advancement"]', { timeout: 10_000 })
      await page.getByRole('button', { name: 'Confirm & advance' }).click()
      await page.waitForFunction(
        () => document.querySelector('.advance-stage-panel .save-status')?.textContent?.includes('Advanced to'),
        { timeout: 10_000 }
      )

      const instanceYamlAfterAdvance = await readOpfsFile(page, workspaceId, `gantry-workspace/${slug}/instance.yaml`)
      assert.match(instanceYamlAfterAdvance, /stage: design-stage/, 'instance.yaml advanced to the local-workspace definition\'s own second stage')

      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

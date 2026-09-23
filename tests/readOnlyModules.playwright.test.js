import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML, stringify as stringifyYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance, writeModule } from '../lib/instance.js'
import { loadDefinition } from '../lib/definition.js'

// #152 (docs/adr/0050): a Stage's `read-only-modules`, seen from the two places an author meets it —
// the instance editor (a carried-forward Module shown read-only, naming its home Stage) and the
// Definitions page (a per-mounted-Module toggle on a draft, surviving Save and Publish). The server's
// refusal is covered under node --test in tests/readOnlyModules.test.js.

const DEFINITION = 'recruitment-onboarding'

async function withPage(fn, { acceptDialogs = false } = {}) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } })
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    if (acceptDialogs) page.on('dialog', (d) => d.accept())
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) pageErrors.push(msg.text())
    })
    await fn(page, pageErrors)
  } finally {
    await browser.close()
  }
}

// recruitment-onboarding v2 copied as `version` with `status`, and `read-only-modules` set per Stage.
function copyDefinition(definitionsDir, { version = 2, status = 'published', readOnly = {} } = {}) {
  const dir = join(definitionsDir, DEFINITION, String(version))
  cpSync(`definitions/${DEFINITION}/2`, dir, { recursive: true })
  const raw = parseYAML(readFileSync(join(dir, 'definition.yaml'), 'utf8'))
  raw.version = version
  raw.status = status
  for (const stage of raw.stages) {
    if (readOnly[stage.id]) stage['read-only-modules'] = readOnly[stage.id]
  }
  writeFileSync(join(dir, 'definition.yaml'), stringifyYAML(raw))
}

async function withFixture(setup, fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-read-only-ui-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  try {
    setup({ definitionsDir, instancesDir })
    await withRunningServer({ definitionsDir, instancesDir }, (base) => fn({ base, definitionsDir, instancesDir }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('the instance editor shows a read-only Module as its saved content, with no editors or required markers and a note naming its home Stage', async () => {
  await withFixture(
    ({ definitionsDir, instancesDir }) => {
      copyDefinition(definitionsDir, { readOnly: { provisioning: ['role', 'selection'] } })
      createInstance(DEFINITION, 'hire', { instancesDir, definitionsDir })
      const definition = loadDefinition(DEFINITION, { definitionsDir })
      writeModule(definition, 'hire', 'role', { fields: { summary: 'A payroll analyst for the finance team.', responsibilities: ['Run the monthly pay cycle'] } }, { instancesDir })
      const instanceYaml = join(instancesDir, 'hire', 'instance.yaml')
      writeFileSync(instanceYaml, readFileSync(instanceYaml, 'utf8').replace('stage: requisition', 'stage: provisioning'))
    },
    async ({ base, instancesDir }) => {
      await withPage(async (page, pageErrors) => {
        const puts = []
        page.on('response', (res) => {
          if (res.request().method() === 'PUT' && /\/api\/instance\/modules/.test(res.url())) puts.push(res.status())
        })
        await page.goto(`${base}/instance/hire`)
        const role = page.locator('.module', { has: page.locator('h2', { hasText: /^Role$/ }) })
        await role.locator('.read-only-note').waitFor({ state: 'visible' })

        assert.match(await role.locator('.read-only-note').textContent(), /carried forward from Appointment/)
        // A read-only value is rendered into its card after paint, so wait on the content itself.
        await role.locator('.read-only-value', { hasText: 'A payroll analyst for the finance team.' }).waitFor()
        await role.locator('li', { hasText: 'Run the monthly pay cycle' }).waitFor()
        assert.equal(await role.locator('li', { hasText: 'Run the monthly pay cycle' }).count(), 1)
        assert.equal(await role.locator('.cm-editor, input, textarea, select, button').count(), 0, 'no editing controls in a read-only module')
        const roleHeadings = await role.locator('h3.field-heading').allTextContents()
        assert.ok(roleHeadings.length > 0)
        assert.ok(roleHeadings.every((h) => !h.endsWith('*')), `no required markers: ${roleHeadings.join(' | ')}`)
        assert.match(await page.locator('.module', { has: page.locator('h2', { hasText: /^Selection$/ }) }).locator('.read-only-note').textContent(), /Appointment/)

        // An editable Module on the same Stage keeps its editors and required markers, and saving it
        // works: the read-only Modules are never part of the save.
        const identity = page.locator('.module', { has: page.locator('h2', { hasText: /^Identity$/ }) })
        await identity.locator('.cm-editor').first().waitFor({ state: 'visible' })
        assert.equal(await identity.locator('.read-only-note').count(), 0)
        assert.ok((await identity.locator('h3.field-heading').allTextContents()).some((h) => h.endsWith('*')))
        const roleBefore = readFileSync(join(instancesDir, 'default', 'hire', 'modules', 'role.md'), 'utf8')
        await identity.locator('.field-markdown').first().locator('.cm-content').click()
        await page.keyboard.type('Account created.')
        const save = page.locator('.toolbar .stage-save-btn')
        // The button is disabled while the save is in flight too, so wait for the save's own response.
        const saved = page.waitForResponse((res) => res.request().method() === 'PUT' && /\/api\/instance\/modules/.test(res.url()))
        await save.click()
        await saved
        assert.deepEqual(puts, [200])
        assert.match(readFileSync(join(instancesDir, 'default', 'hire', 'modules', 'identity.md'), 'utf8'), /Account created\./)
        assert.equal(readFileSync(join(instancesDir, 'default', 'hire', 'modules', 'role.md'), 'utf8'), roleBefore)

        // At its home Stage the same Module is an ordinary editable card.
        await page.locator('#stage-nav').getByRole('button', { name: 'Appointment' }).click()
        await page.locator('#stage-line', { hasText: 'Appointment' }).waitFor()
        const roleAtHome = page.locator('.module', { has: page.locator('h2', { hasText: /^Role$/ }) })
        await roleAtHome.locator('.cm-editor').first().waitFor({ state: 'visible' })
        assert.equal(await roleAtHome.locator('.read-only-note').count(), 0)

        assert.deepEqual(pageErrors, [])
      })
    }
  )
})

// A local-workspace instance builds its module entries in the browser (web/app.js's
// loadLocalInstance), so it gets the same marking from the Definition's stages, not from the server.
test('a local-workspace instance shows a read-only Module read-only too', async () => {
  await withFixture(
    ({ definitionsDir }) => copyDefinition(definitionsDir, { readOnly: { provisioning: ['role', 'selection'] } }),
    async ({ base }) => {
      await withPage(async (page, pageErrors) => {
        // Navigate first so the page has a real origin for OPFS and IndexedDB.
        await page.goto(`${base}/`)
        const workspaceId = await page.evaluate(async (instanceYaml) => {
          const { rememberWorkspace } = await import('/lib/localWorkspace.js')
          const root = await navigator.storage.getDirectory()
          const dir = await root.getDirectoryHandle(`local-ws-${Date.now()}`, { create: true })
          let d = dir
          for (const part of ['gantry-workspace', 'hire']) d = await d.getDirectoryHandle(part, { create: true })
          const writable = await (await d.getFileHandle('instance.yaml', { create: true })).createWritable()
          await writable.write(instanceYaml)
          await writable.close()
          return rememberWorkspace({ handle: dir, name: 'Local read-only workspace' })
        }, `definition: ${DEFINITION}\nslug: hire\nstage: provisioning\ndefinitionVersion: 2\n`)

        await page.goto(`${base}/instance/hire?local=${encodeURIComponent(workspaceId)}`)
        const role = page.locator('.module', { has: page.locator('h2', { hasText: /^Role$/ }) })
        await role.locator('.read-only-note', { hasText: 'carried forward from Appointment' }).waitFor()
        assert.equal(await role.locator('.cm-editor').count(), 0)
        const identity = page.locator('.module', { has: page.locator('h2', { hasText: /^Identity$/ }) })
        await identity.locator('.cm-editor').first().waitFor({ state: 'visible' })
        assert.equal(await identity.locator('.read-only-note').count(), 0)

        assert.deepEqual(pageErrors, [])
      })
    }
  )
})

test('the Definitions page marks a mounted Module read-only on a draft Stage; it survives Save, reload and Publish', async () => {
  await withFixture(
    ({ definitionsDir }) => {
      copyDefinition(definitionsDir, { version: 2, status: 'published' })
      copyDefinition(definitionsDir, { version: 3, status: 'draft' })
    },
    async ({ base, definitionsDir }) => {
      await withPage(async (page, pageErrors) => {
        const openStage = async (title) => {
          await page.goto(`${base}/definitions`)
          await page.waitForSelector('#defn-version-select')
          await page.locator('#defn-version-select').selectOption('3')
          await page.waitForSelector('.defn-outline')
          await page.locator('.defn-outline-group').first().locator('.defn-outline-node', { hasText: title }).click()
          await page.locator('.defn-focus .kicker', { hasText: 'Modules in this stage' }).waitFor()
        }
        const toggle = (title) => page.getByRole('checkbox', { name: `Read-only at this stage: ${title}`, exact: true })

        await openStage('Provisioning')
        assert.equal(await toggle('Role').isChecked(), false)
        await toggle('Role').check()
        await toggle('Selection').check()
        const saveBtn = page.getByRole('button', { name: 'Save', exact: true })
        await saveBtn.click()
        await page.waitForFunction(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save')?.disabled === true)

        const yamlOf = () => parseYAML(readFileSync(join(definitionsDir, DEFINITION, '3', 'definition.yaml'), 'utf8'))
        const provisioning = () => yamlOf().stages.find((s) => s.id === 'provisioning')
        assert.deepEqual(provisioning()['read-only-modules'], ['role', 'selection'])
        // Stages nobody marked stay exactly as they were — the key is opt-in.
        assert.ok(yamlOf().stages.filter((s) => s.id !== 'provisioning').every((s) => !('read-only-modules' in s)))

        await openStage('Provisioning')
        assert.equal(await toggle('Role').isChecked(), true)
        assert.equal(await toggle('Identity').isChecked(), false)

        await page.getByRole('button', { name: 'Publish', exact: true }).click()
        await page.waitForSelector('.stamp.agreed')
        assert.equal(yamlOf().status, 'published')
        assert.deepEqual(provisioning()['read-only-modules'], ['role', 'selection'])
        // Published: no toggle, but the marking still shows.
        await page.locator('.defn-outline-group').first().locator('.defn-outline-node', { hasText: 'Provisioning' }).click()
        const roleChip = page.locator('.defn-focus .defn-chip.read-only', { hasText: 'Role' })
        await roleChip.waitFor()
        assert.equal(await page.getByRole('checkbox', { name: /Read-only at this stage/ }).count(), 0)

        assert.deepEqual(pageErrors, [])
      }, { acceptDialogs: true })
    }
  )
})

test('the Definitions page marks a Stage that lists an unmounted Module read-only, and Save is refused until it is fixed', async () => {
  await withFixture(
    ({ definitionsDir }) => {
      copyDefinition(definitionsDir, { version: 2, status: 'published' })
      copyDefinition(definitionsDir, { version: 3, status: 'draft', readOnly: { requisition: ['payroll'] } })
    },
    async ({ base, definitionsDir }) => {
      await withPage(async (page) => {
        await page.goto(`${base}/definitions`)
        await page.waitForSelector('#defn-version-select')
        await page.locator('#defn-version-select').selectOption('3')
        await page.waitForSelector('.defn-outline')

        const problemsBtn = page.locator('.defn-problems', { hasText: 'problem' })
        await problemsBtn.waitFor()
        await page.locator('.defn-outline-group').first().locator('.defn-outline-node', { hasText: 'Requisition' }).locator('.defn-problem-dot').waitFor()
        await problemsBtn.click()
        await page.locator('.defn-focus-row input.mono').first().waitFor()
        assert.equal(await page.locator('.defn-focus .kicker').first().textContent(), 'Stage')
        assert.equal(await page.locator('.defn-focus-row input.mono').first().inputValue(), 'requisition')

        // Any other change leaves the draft unsaveable while the bad entry stands.
        const yamlPath = join(definitionsDir, DEFINITION, '3', 'definition.yaml')
        const before = readFileSync(yamlPath, 'utf8')
        await page.locator('.defn-outline-group').first().locator('.defn-outline-node', { hasText: 'Provisioning' }).click()
        await page.getByRole('checkbox', { name: 'Read-only at this stage: Role', exact: true }).check()
        const saved = page.waitForResponse((res) => res.request().method() === 'PUT' && /\/api\/definitions\//.test(res.url()))
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        assert.equal((await saved).status(), 422)
        assert.equal(readFileSync(yamlPath, 'utf8'), before)
      }, { acceptDialogs: true })
    }
  )
})

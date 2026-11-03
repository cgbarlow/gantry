import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { INTERVIEW_RULES } from '../web/lib/interviewRules.js'
import { INTERVIEW_SKILLS } from '../web/lib/interviewSkills.js'

// #285 (docs/adr/0065): the read-only "Gantry's interview rules" view beside the Interview instructions
// editor — on the Definitions page (draft and published) and in the Local Workspace Definition editor. It
// shows the fixed rules, the two bundled skills with their pinned version, their credit and licence, and
// the bundled skill files are served so the AI can be given them. tests/interviewBrief.test.js,
// tests/interviewAdapter.test.js and tests/interviewSkills.test.js cover the content behind it.

const SUMMARY_MODULE = `id: summary
title: Summary
purpose: What this is
fields:
  - id: overview
    title: Overview
    type: markdown
    required: true
`

function definitionYaml(id, { status = 'draft', interview = '' } = {}) {
  return `id: ${id}\nversion: 1\nstatus: ${status}\ntitle: ${id}\ndescription: A one-stage fixture\n${interview ? `interview: ${JSON.stringify(interview)}\n` : ''}stages:\n  - id: draft\n    title: Draft\n    purpose: Write it\n    gate: drafted\n    modules:\n      - summary\nartefacts:\n  - id: brief\n    title: Brief\n    purpose: The brief\n    template: templates/brief.md.tmpl\n    gate: drafted\n    requires:\n      - summary\n`
}

function writeFixtureDefinition(definitionsDir, id, options) {
  const dir = join(definitionsDir, id, '1')
  mkdirSync(join(dir, 'modules'), { recursive: true })
  mkdirSync(join(dir, 'templates'), { recursive: true })
  writeFileSync(join(dir, 'definition.yaml'), definitionYaml(id, options))
  writeFileSync(join(dir, 'modules', 'summary.yaml'), SUMMARY_MODULE)
  writeFileSync(join(dir, 'templates', 'brief.md.tmpl'), '# Brief\n\n<%~ it.modules.summary.overview %>\n')
}

async function withFixtureServer(definitions, fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-285-browser-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-285-browser-'))
  try {
    for (const [id, options] of Object.entries(definitions)) writeFixtureDefinition(definitionsDir, id, options)
    await withRunningServer({ definitionsDir, instancesDir, migrateWorkspacesOnStart: false }, (base) => fn({ base }))
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    page.setDefaultTimeout(DEFAULT_TIMEOUT)
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    page.on('console', (msg) => {
      if (msg.type() === 'error') pageErrors.push(msg.text())
    })
    await fn(page, pageErrors)
  } finally {
    await browser.close()
  }
}

async function assertRulesView(page) {
  const view = page.getByTestId('interview-rules')
  await view.waitFor({ timeout: 10_000 })
  await view.locator('summary').first().click()
  assert.equal(await page.getByTestId('interview-rule').count(), INTERVIEW_RULES.length, "every one of Gantry's rules is shown")
  for (const rule of INTERVIEW_RULES) {
    assert.ok((await view.textContent()).includes(rule.title), rule.title)
  }
  const versions = await page.getByTestId('interview-rules-versions').textContent()
  assert.match(versions, new RegExp(`${INTERVIEW_SKILLS.package} ${INTERVIEW_SKILLS.version.replace(/\./g, '\\.')}`))
  for (const skill of INTERVIEW_SKILLS.skills) {
    const row = page.getByTestId(`interview-skill-${skill.id}`)
    assert.ok((await row.textContent()).includes(`version ${INTERVIEW_SKILLS.version}`), `${skill.id} shows its version`)
  }
  const credit = await page.getByTestId('interview-skills-credit').textContent()
  assert.match(credit, /Matt Pocock/)
  assert.match(credit, /MIT/)
  assert.equal(await view.locator('textarea, input').count(), 0, 'read-only: nothing to edit')
  assert.match(await view.textContent(), /Where a skill and a rule clash/)
}

test('the Definitions page shows Gantry\'s interview rules and the skill versions beside the Interview instructions, on a draft and a published version', () =>
  withFixtureServer({ steer: {} }, async ({ base }) => {
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      // A draft: the editor and the rules together.
      await page.locator('.defn-outline-interview .defn-outline-node', { hasText: 'Interview instructions' }).click()
      await page.getByRole('textbox', { name: 'Interview instructions' }).waitFor({ timeout: 10_000 })
      await assertRulesView(page)

      // The bundled skill files are served, so the browser can hand them to the AI.
      const served = await page.evaluate(async () => {
        const grilling = await fetch('/interview-skills/grilling/SKILL.md')
        const licence = await fetch('/interview-skills/LICENSE')
        return { grillingStatus: grilling.status, grilling: (await grilling.text()).slice(0, 200), licenceStatus: licence.status, licence: (await licence.text()).slice(0, 20) }
      })
      assert.equal(served.grillingStatus, 200)
      assert.match(served.grilling, /name: grilling/)
      assert.equal(served.licenceStatus, 200)
      assert.match(served.licence, /MIT License/)

      assert.deepEqual(pageErrors, [])
    })
  }))

test('a published Definition with Interview instructions shows the rules read-only beside them', () =>
  withFixtureServer({ live: { status: 'published', interview: 'Ask who the sponsor is first.' } }, async ({ base }) => {
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/definitions`)
      await page.waitForSelector('.defn-outline', { timeout: 10_000 })
      await page.locator('.defn-outline-interview .defn-outline-node', { hasText: 'Interview instructions' }).click()
      await page.getByTestId('interview-instructions').waitFor({ timeout: 10_000 })
      await assertRulesView(page)
      assert.deepEqual(pageErrors, [])
    })
  }))

test('the Local Workspace Definition editor shows the same rules view', () =>
  withFixtureServer({}, async ({ base }) => {
    await withPage(async (page, pageErrors) => {
      await page.goto(`${base}/`)
      const files = {
        'definitions/steer/1/definition.yaml': definitionYaml('steer'),
        'definitions/steer/1/modules/summary.yaml': SUMMARY_MODULE,
        'definitions/steer/1/templates/brief.md.tmpl': '# Brief\n',
      }
      const workspaceId = await page.evaluate(async (files) => {
        const { rememberWorkspace, writeTextFile } = await import('/lib/localWorkspace.js')
        const root = await navigator.storage.getDirectory()
        const dir = await root.getDirectoryHandle('local-ws-285-' + Date.now(), { create: true })
        for (const [path, text] of Object.entries(files)) await writeTextFile(dir, path, text)
        return rememberWorkspace({ handle: dir, name: 'Interview Rules Workspace' })
      }, files)

      await page.goto(`${base}/definitions/local?ws=${encodeURIComponent(workspaceId)}&id=steer&version=1`)
      await page.locator('.local-def-interview').getByRole('textbox', { name: 'Interview instructions' }).waitFor({ timeout: 10_000 })
      await assertRulesView(page)

      await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory()
        for await (const [name] of root.entries()) if (name.startsWith('local-ws-285-')) await root.removeEntry(name, { recursive: true })
      })
      assert.deepEqual(pageErrors, [])
    })
  }))

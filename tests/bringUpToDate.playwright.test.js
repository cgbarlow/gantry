import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYAML } from 'yaml'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { showFields, showSourcesAndDecisions } from './helpers/referenceView.js'
import { GITHUB_OWNER, GITHUB_REPOSITORY, ORGANIZATION, PROJECT, REPOSITORY, withRunningServer, withRunningServerForProvider } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'
import { createAzureDevOpsClient } from '../lib/azureDevOpsClient.js'
import { createGitHubClient } from '../lib/githubClient.js'
import { registerInstance } from '../lib/instanceRegistry.js'
import { stageBranchName } from '../lib/stageBranch.js'
import { serializeDecisionsLog } from '../web/lib/decisionsLog.js'
import { sourceTextPath, sourceTextRef, stringifySourceManifest } from '../web/lib/sourceDocuments.js'
import { seedProviders, withFakeAnthropic } from './helpers/interviewStandIn.js'
import { pairModuleText, writePair } from './helpers/pairDefinition.js'

// #298 (parent #238, decided in #249): "Bring up to date" on a server workspace. A real server and relay, a real Chromium page and a stand-in
// for Anthropic. The rules (which Field lands where, the cards, what an answer means) are covered under node --test in
// tests/bringUpToDate.test.js and tests/bringUpToDateSession.test.js; this is the screen: the banner's link, stage-by-stage order, the cards, the
// keep / redraft / re-cite answers and what they leave on disk, the round that starts a normal session, and an agreed Module going back to draft.

const SLUG = 'pair-test'
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const mdFile = (name, text) => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) })
const readYaml = (file) => parseYAML(readFileSync(file, 'utf8'))

// The stand-in AI redrafts the Field it is told to: the first turn of a request drafts it, the turn after the draft result is a short reply.
const redraftScript = (body) => {
  const first = body.messages[0]
  const text = typeof first.content === 'string' ? first.content : first.content.map((b) => b.text ?? '').join('\n')
  if (body.messages.every((m) => m.role === 'user')) {
    const field = /(m[ab]\.body|ms\.body) \([^)]*\): REDRAFT/.exec(text)?.[1]
    if (field) return { text: `Redrafting ${field}.`, tools: [{ id: `d-${field}`, input: { field, value: `Redrafted ${field} from the new brief [Brief v2](source:brief-v2).` } }] }
    return { text: 'Reading the Source documents.' }
  }
  return { text: 'Done.' }
}

async function withPairServer(fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-298-e2e-'))
  const definitionsDir = join(root, 'definitions')
  const instancesDir = join(root, 'instances')
  try {
    writePair(definitionsDir)
    mkdirSync(instancesDir)
    createInstance('pair', SLUG, { instancesDir, definitionsDir, definitionVersion: 1 })
    await withFakeAnthropic(redraftScript, (aiBase, posts) =>
      withRunningServer({ slug: SLUG, instancesDir, definitionsDir, allowPrivateAiUrls: true }, async (base) => {
        const browser = await launchBrowser()
        try {
          const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
          page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
          const pageErrors = []
          page.on('pageerror', (err) => pageErrors.push(err.message))
          await seedProviders(page, aiBase)
          await fn({ page, base, posts, folder: instanceFolder(instancesDir) })
          assert.deepEqual(pageErrors, [])
        } finally {
          await browser.close()
        }
      })
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function instanceFolder(instancesDir) {
  for (const candidate of [join(instancesDir, 'default', SLUG), join(instancesDir, SLUG)]) if (existsSync(join(candidate, 'instance.yaml'))) return candidate
  throw new Error('no instance folder')
}

const openPanel = async (page) => {
  await showSourcesAndDecisions(page)
  const panel = page.locator('[data-testid="source-documents"]')
  await panel.waitFor({ timeout: 15_000 })
  if (!(await panel.evaluate((el) => el.open))) await panel.locator('[data-testid="source-documents-summary"]').click()
  return panel
}
const rowFor = (panel, title) => panel.locator('tr[data-source-id]').filter({ hasText: title })
const upload = async (panel, name, text) => {
  await panel.locator('[data-testid="source-documents-input"]').setInputFiles(mdFile(name, text))
  await rowFor(panel, name.replace(/\.md$/, '')).first().waitFor()
  await pause(30)
}
const setModules = (folder, modules) => {
  for (const [id, body, status] of modules) writeFileSync(join(folder, 'modules', `${id}.md`), pairModuleText(id, body, status))
}
const setStage = (folder, stage) => {
  const file = join(folder, 'instance.yaml')
  writeFileSync(file, readFileSync(file, 'utf8').replace(/^stage: .*$/m, `stage: ${stage}`))
}
const cardIds = (page) => page.locator('[data-testid="interview-card"]').evaluateAll((els) => els.map((el) => el.dataset.cardId))
const choose = (page, card, label) => page.locator(`[data-testid="interview-card"][data-card-id="${card}"] [data-testid="card-option"][data-option="${label}"] input`).check()
const chosen = (page, card) => page.locator(`[data-testid="interview-card"][data-card-id="${card}"] [data-testid="card-option"][data-chosen="true"]`).evaluateAll((els) => els.map((el) => el.dataset.option))

// The editor of the pair at Beta, with the Brief and the Notes uploaded and cited by hand.
async function seedCitations(page, base, folder) {
  setStage(folder, 'b')
  await page.goto(`${base}/instance/${SLUG}`)
  await page.waitForSelector('.module', { timeout: 15_000 })
  const panel = await openPanel(page)
  await upload(panel, 'Brief.md', '# Brief\n\nAlpha claims take 12 days.\n')
  await upload(panel, 'Notes.md', '# Notes\n\nBeta notes.\n')
  setModules(folder, [
    ['ma', 'Alpha claims [Brief, p. 1](source:brief).'],
    ['mb', 'Beta notes [Brief](source:brief) and [Notes](source:notes).'],
    ['ms', 'Shared and cites nothing.'],
  ])
  await page.reload()
  await page.waitForSelector('.module', { timeout: 15_000 })
  return openPanel(page)
}

test('server workspace: the banner opens the round on the first Stage that has flagged Fields, a redraft goes through keep / use / merge, a keep needs no AI, and the flags clear only as the cards are answered', async () => {
  await withPairServer(async ({ page, base, posts, folder }) => {
    const panel = await seedCitations(page, base, folder)
    await panel.locator('[data-testid="source-replaces"]').selectOption({ label: 'This replaces… Brief' })
    await upload(panel, 'Brief v2.md', '# Brief v2\n\nAlpha claims take 11 days.\n')

    // Two Fields drew on the Brief, one on each Stage: Alpha's `ma.body` and Beta's `mb.body`. Beta is the current Stage.
    await showFields(page)
    const banner = page.locator('[data-testid="out-of-date-banner"]')
    await banner.waitFor()
    assert.match(await page.locator('[data-testid="out-of-date-line"]').textContent(), /^2 Fields drew on Brief, now replaced by Brief v2:/)
    await page.click('[data-testid="bring-up-to-date"]')

    // It opens on Alpha, the first Stage with a flagged Field, though Beta is the current Stage. Beta is next in line.
    await page.waitForSelector('[data-testid="interview-update-intro"]')
    assert.match(page.url(), /interview=1/)
    assert.match(page.url(), /update=1/)
    assert.match(await page.textContent('.interview-rail .interview-instance + .cite'), /Alpha/)
    assert.match(await page.textContent('[data-testid="interview-update-count"]'), /^1 Field on Alpha is Out of date/)
    assert.match(await page.textContent('[data-testid="interview-update-next"]'), /1 Field on Beta is Out of date too/)
    assert.equal(await page.locator('[data-testid="interview-run-until"]').count(), 0, 'it is not a run')
    assert.equal(await page.locator('[data-testid="interview-blocked"]').count(), 0, 'Alpha is not the current Stage, and that is fine here')
    assert.match(await page.textContent('[data-testid="interview-start"]'), /Bring up to date/)
    // #331: the same opening box as an interview's kickoff, blank.
    assert.equal(await page.inputValue('[data-testid="interview-opening"]'), '')
    await page.fill('[data-testid="interview-opening"]', 'The new brief moves the deadline; keep that in mind.')
    await page.click('[data-testid="interview-start"]')

    // The cards come before the AI is called: one card for the one Field, Redraft recommended.
    await page.waitForSelector('[data-testid="interview-round"]')
    assert.equal(posts.length, 0, 'the AI has not been called')
    assert.match(await page.textContent('[data-testid="round-head"]'), /Bring up to date · 1 Field/)
    assert.deepEqual(await cardIds(page), ['update:ma.body'])
    assert.match(await page.textContent('[data-testid="card-question"]'), /Alpha notes · Body: Brief was replaced by Brief v2\. What should happen to it\?/)
    assert.deepEqual(await page.locator('[data-testid="card-option"]').evaluateAll((els) => els.map((el) => el.dataset.option)), ['Keep', 'Redraft'])
    assert.deepEqual(await chosen(page, 'update:ma.body'), ['Redraft'])
    assert.equal(await page.locator('[data-testid="card-recommended"]').count(), 1)
    assert.match(await page.textContent('[data-testid="update-card-saved"]'), /Alpha claims/)
    assert.equal(await page.locator('[data-testid="card-other"]').count(), 0)
    // The Field is marked in the preview until its card is answered.
    assert.equal(await page.locator('[data-testid="interview-field"][data-field-key="ma.body"] [data-testid="interview-field-out-of-date"]').count(), 1)

    // Redraft: the AI is told only that Field; its draft meets the keep / use the AI's version / merge card.
    await page.click('[data-testid="round-submit"]')
    await page.waitForSelector('[data-testid="interview-card"][data-card-type="change"]')
    assert.match(posts[0].raw, /REDRAFT/)
    assert.doesNotMatch(posts[0].raw, /Begin the interview/)
    // As the last message it carries the conversation's cache point (#328), so its text sits in a block.
    const opening = posts[0].body.messages[1]
    assert.equal(opening.role, 'user')
    assert.deepEqual([opening.content].flat().map((b) => b.text ?? b), ['The new brief moves the deadline; keep that in mind.'], 'the opening message goes with the first request, after the answers')
    assert.deepEqual(await page.locator('[data-testid="interview-msg"][data-who="you"]').first().textContent(), 'The new brief moves the deadline; keep that in mind.')
    assert.deepEqual(await page.locator('[data-testid="interview-card"][data-card-type="change"] [data-testid="card-option"]').evaluateAll((els) => els.map((el) => el.dataset.option)), ['Keep', "Use the AI's version", 'Merge'])
    await choose(page, 'change:ma.body', "Use the AI's version")
    await page.click('[data-testid="round-submit"]')
    await page.waitForSelector('[data-testid="update-ready"]')
    assert.match(await page.textContent('[data-testid="interview-field"][data-field-key="ma.body"] [data-testid="interview-field-value"]'), /Redrafted ma\.body/)
    assert.equal(readFileSync(join(folder, 'modules', 'ma.md'), 'utf8').includes('Redrafted'), false, 'nothing is saved before the round is')

    await page.click('[data-testid="update-save"]')
    await page.waitForSelector('[data-testid="update-saved"]')
    assert.match(await page.textContent('[data-testid="update-saved-summary"]'), /1 answer logged, 1 Field changed/)
    const alpha = readYaml(join(folder, 'interview', 'a.yaml'))
    assert.match(readFileSync(join(folder, 'modules', 'ma.md'), 'utf8'), /Redrafted ma\.body from the new brief/)
    assert.match(readFileSync(join(folder, 'modules', 'ma.md'), 'utf8'), /status: draft/)
    const answer = alpha.entries.find((e) => e.kind === 'source-update')
    assert.deepEqual([answer.source, answer.change, answer.outcome, answer.replacedBy, answer.fields], ['brief', 'replaced', 'redraft', 'Brief v2', ['ma.body']])
    assert.ok(alpha.entries.some((e) => e.kind === 'saved-content' && e.choice === 'replace'))
    assert.ok(alpha.fields['ma.body'], 'the redrafted Field has its record')
    assert.equal(alpha.status[0].state, 'done')
    assert.equal(readYaml(join(folder, 'instance.yaml')).stage, 'b', 'the Instance has not moved')

    // Next, Beta: its Field is asked about on its own page. Keep it: no AI, and the Stage's status line is left alone.
    const sent = posts.length
    await page.click('[data-testid="update-next-button"]')
    await page.waitForSelector('[data-testid="interview-update-count"]')
    assert.match(await page.textContent('.interview-rail .interview-instance + .cite'), /Beta/)
    assert.match(await page.textContent('[data-testid="interview-update-count"]'), /^1 Field on Beta is Out of date/)
    assert.equal(await page.locator('[data-testid="interview-update-next"]').count(), 0, 'Alpha is done')
    await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-round"]')
    assert.deepEqual(await cardIds(page), ['update:mb.body'])
    await choose(page, 'update:mb.body', 'Keep')
    await page.click('[data-testid="round-submit"]')
    await page.waitForSelector('[data-testid="update-ready"]')
    assert.equal(posts.length, sent, 'a kept Field needs no AI')
    // Nothing is cleared yet: the flag is still on the page until the round is saved.
    assert.equal(await page.locator('[data-testid="interview-field"][data-field-key="mb.body"] [data-testid="interview-field-out-of-date"]').count(), 1)
    await page.click('[data-testid="update-save"]')
    await page.waitForSelector('[data-testid="update-saved"]')
    const beta = readYaml(join(folder, 'interview', 'b.yaml'))
    const kept = beta.entries.find((e) => e.kind === 'source-update')
    assert.deepEqual([kept.source, kept.outcome, kept.fields], ['brief', 'keep', ['mb.body']])
    assert.deepEqual(beta.status ?? [], [], 'a round that needed no AI leaves the Stage’s status alone')
    assert.match(readFileSync(join(folder, 'modules', 'mb.md'), 'utf8'), /Beta notes \[Brief\]\(source:brief\)/, 'a kept Field is exactly as it was')

    // Both cards answered and saved: nothing is Out of date any more, in the editor or the run plan.
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="run-plan-out-of-date"]').length === 0)
    await page.click('[data-testid="update-back-to-editor"]')
    await page.waitForSelector('.module')
    const panel2 = await openPanel(page)
    await panel2.locator('tr[data-source-id="brief-v2"]').waitFor()
    await page.waitForTimeout(600)
    assert.equal(await page.locator('[data-testid="out-of-date-banner"]').count(), 0)
    assert.equal(await page.locator('[data-testid="field-out-of-date"]').count(), 0)
  })
})

test('server workspace: a removed document offers keep, re-cite and redraft without it; a re-cite is Gantry’s own change, with no AI', async () => {
  await withPairServer(async ({ page, base, posts, folder }) => {
    const panel = await seedCitations(page, base, folder)
    await upload(panel, 'Workshop.md', '# Workshop\n\nBeta notes, said again.\n')
    await rowFor(panel, 'Notes').getByRole('button', { name: 'Remove' }).click()
    await panel.locator('[data-testid="source-documents-confirm-remove"]').click()
    await page.waitForFunction(() => /Notes, now removed/.test(document.querySelector('[data-testid="out-of-date-banner"]')?.textContent ?? ''))

    await showFields(page)
    await page.click('[data-testid="bring-up-to-date"]')
    await page.waitForSelector('[data-testid="interview-update-intro"]')
    assert.match(await page.textContent('[data-testid="interview-update-count"]'), /^1 Field on Beta is Out of date/)
    await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-round"]')

    // Keep, a re-cite for each other live document, and redraft without it. The Field also cites the Brief, so the Brief already supports it and re-citing to it is recommended.
    assert.deepEqual(await page.locator('[data-testid="card-option"]').evaluateAll((els) => els.map((el) => el.dataset.option)), ['Keep', 'Re-cite to Brief', 'Re-cite to Workshop', 'Redraft without it'])
    assert.deepEqual(await chosen(page, 'update:mb.body'), ['Re-cite to Brief'])
    assert.match(await page.textContent('[data-testid="card-why"]'), /Brief already supports this Field/)
    assert.match(await page.textContent('[data-testid="card-option"][data-option="Keep"]'), /shows "removed"/)
    assert.match(await page.textContent('[data-testid="card-cite"]'), /Notes/)

    await choose(page, 'update:mb.body', 'Re-cite to Workshop')
    await page.click('[data-testid="round-submit"]')
    await page.waitForSelector('[data-testid="update-ready"]')
    assert.equal(posts.length, 0, 'a re-cite is not the AI’s')
    assert.match(await page.textContent('[data-testid="interview-field"][data-field-key="mb.body"] [data-testid="interview-field-value"]'), /Beta notes/)
    assert.equal(await page.locator('[data-testid="interview-field"][data-field-key="mb.body"] [data-testid="interview-ai-mark"]').count(), 1, 'it shows as an unsaved change')
    await page.click('[data-testid="update-save"]')
    await page.waitForSelector('[data-testid="update-saved"]')

    const text = readFileSync(join(folder, 'modules', 'mb.md'), 'utf8')
    assert.match(text, /\[Workshop\]\(source:workshop\)/)
    assert.doesNotMatch(text, /source:notes/)
    assert.match(text, /\[Brief\]\(source:brief\)/, 'a citation of another document is left alone')
    const beta = readYaml(join(folder, 'interview', 'b.yaml'))
    const entry = beta.entries.find((e) => e.kind === 'source-update')
    assert.deepEqual([entry.source, entry.change, entry.outcome, entry.reciteTo], ['notes', 'removed', 're-cite', 'Workshop'])
    assert.ok(beta.fields['mb.body'].inputs.some((i) => i.source === 'workshop'))
    assert.ok(!beta.fields['mb.body'].inputs.some((i) => i.source === 'notes'))
    await page.click('[data-testid="update-back-to-editor"]')
    await page.waitForSelector('.module')
    await page.waitForTimeout(800)
    assert.equal(await page.locator('[data-testid="out-of-date-banner"]').count(), 0)
  })
})

test('server workspace: a normal interview starts with the round when flags are waiting, then carries on; an agreed Module goes back to draft with a note', async () => {
  await withPairServer(async ({ page, base, posts, folder }) => {
    // Alpha is the current Stage here, and its Module is agreed.
    setStage(folder, 'a')
    await page.goto(`${base}/instance/${SLUG}`)
    await page.waitForSelector('.module', { timeout: 15_000 })
    const panel = await openPanel(page)
    await upload(panel, 'Brief.md', '# Brief\n\nAlpha claims take 12 days.\n')
    setModules(folder, [['ma', 'Alpha claims [Brief, p. 1](source:brief).', 'agreed'], ['ms', 'Shared.']])
    await page.reload()
    await page.waitForSelector('.module', { timeout: 15_000 })
    const panel2 = await openPanel(page)
    await panel2.locator('[data-testid="source-replaces"]').selectOption({ label: 'This replaces… Brief' })
    await upload(panel2, 'Brief v2.md', '# Brief v2\n\nAlpha claims take 11 days.\n')
    await showFields(page)
    await page.waitForSelector('[data-testid="out-of-date-banner"]')

    await page.goto(`${base}/instance/${SLUG}?interview=1`)
    await page.waitForSelector('[data-testid="interview-kickoff-update-note"]')
    assert.match(await page.textContent('[data-testid="interview-kickoff-update-note"]'), /1 Field is Out of date\. The interview starts with a round of cards about it/)
    await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-round"]')
    assert.equal(posts.length, 0, 'the round comes before the AI is asked anything')
    assert.deepEqual(await cardIds(page), ['update:ma.body'])

    // The answer goes to the AI as part of the usual opening, which then redrafts the Field.
    await page.click('[data-testid="round-submit"]')
    await page.waitForSelector('[data-testid="interview-card"][data-card-type="change"]')
    assert.match(posts[0].raw, /Begin the interview/)
    assert.match(posts[0].raw, /ma\.body \([^)]*\): REDRAFT/)
    await choose(page, 'change:ma.body', "Use the AI's version")
    await page.click('[data-testid="round-submit"]')
    await page.waitForSelector('[data-testid="interview-field"][data-field-key="ma.body"][data-state="draft"]')

    // Pause saves the drafts and the log as one Save: the agreed Module is draft again, and the Save says why.
    await page.waitForSelector('[data-testid="interview-pause"]:not([disabled])')
    await page.click('[data-testid="interview-pause"]')
    await page.waitForSelector('[data-testid="interview-paused"]')
    assert.match(await page.textContent('[data-testid="interview-returned-to-draft"]'), /Alpha notes was agreed and is back to draft\./)
    assert.match(await page.textContent('[data-testid="interview-returned-to-draft"]'), /because Brief was replaced by Brief v2/)
    const text = readFileSync(join(folder, 'modules', 'ma.md'), 'utf8')
    assert.match(text, /status: draft/)
    assert.doesNotMatch(text, /status: agreed/)
    const log = readYaml(join(folder, 'interview', 'a.yaml'))
    const returned = log.entries.find((e) => e.kind === 'returned-to-draft')
    assert.equal(returned.module, 'ma')
    assert.deepEqual(returned.fields, ['ma.body'])
    assert.match(returned.note, /Only a person marks a Module agreed/)
    assert.ok(log.entries.some((e) => e.kind === 'source-update' && e.outcome === 'redraft'))

    // A document added after that Save replaces nothing, so it flags no Field: it is New since last interview, and the next session's AI is told to
    // read it against what is saved and to ask a card only where it adds to or contradicts something.
    await page.click('[data-testid="interview-resume"]')
    await page.waitForSelector('[data-testid="interview-kickoff"]')
    await page.setInputFiles('[data-testid="source-documents-compact"] [data-testid="source-documents-input"]', mdFile('Workshop.md', '# Workshop\n\nAlpha claims are the same.\n'))
    await page.waitForSelector('[data-testid="interview-kickoff-new-since"]')
    assert.match(await page.textContent('[data-testid="interview-kickoff-new-since"]'), /1 Source document is New since the last interview\. The AI reads it against what is saved, and asks a card only where it adds to or contradicts something\./)
    assert.equal(await page.locator('[data-testid="interview-kickoff-update-note"]').count(), 0, 'the Field was brought up to date, so no flags are waiting')
    await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
    const sent = posts.length
    await page.click('[data-testid="interview-start"]')
    await page.waitForSelector('[data-testid="interview-msg"][data-who="ai"]')
    assert.match(posts[sent].raw, /New since the last interview: \\"Workshop\\"/)
    assert.match(posts[sent].raw, /only where a document adds to or contradicts something already saved/)
  })
})

test('local workspace: Bring up to date reads and writes through the folder: a kept Field is a decisions-log entry and the Field’s text is untouched', async () => {
  await withFakeAnthropic(redraftScript, (aiBase) =>
    withRunningServer({ allowPrivateAiUrls: true }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
        page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        await seedProviders(page, aiBase)
        await page.goto(`${base}/settings`)
        const workspaceId = await page.evaluate(async () => {
          const { rememberWorkspace } = await import('/lib/localWorkspace.js')
          const root = await navigator.storage.getDirectory()
          const dir = await root.getDirectoryHandle('local-ws-' + Date.now(), { create: true })
          const instanceDir = await (await dir.getDirectoryHandle('gantry-workspace', { create: true })).getDirectoryHandle('local-update', { create: true })
          const put = async (parent, name, text) => {
            const w = await (await parent.getFileHandle(name, { create: true })).createWritable()
            await w.write(text)
            await w.close()
          }
          await put(instanceDir, 'instance.yaml', 'definition: design\nslug: local-update\nstage: shape\nassignee: a.architect\ndefinitionVersion: 3\n')
          const modules = await instanceDir.getDirectoryHandle('modules', { create: true })
          await put(
            modules,
            'background.md',
            '---\nmodule: background\nstatus: agreed\nowner: a.architect\n---\n# Background and context\n\n## Problem statement\n\nMedian time to payment is 12.4 days [Client brief, p. 1](source:client-brief).\n\n## Affected domains\n\nClaims.\n'
          )
          return rememberWorkspace({ handle: dir, name: 'Local Update Workspace' })
        })
        await page.goto(`${base}/instance/local-update?local=${encodeURIComponent(workspaceId)}`)
        await page.waitForSelector('.module', { timeout: 15_000 })
        const panel = await openPanel(page)
        const input = panel.locator('[data-testid="source-documents-input"]')
        await input.setInputFiles(mdFile('Client brief.md', '# Client brief\n\nMedian time to payment is 12.4 days.\n'))
        await panel.locator('tr[data-source-id="client-brief"]').waitFor()
        await panel.locator('[data-testid="source-replaces"]').selectOption({ label: 'This replaces… Client brief' })
        await input.setInputFiles(mdFile('Client brief v2.md', '# Client brief v2\n\nMedian time to payment is 11 days.\n'))
        await showFields(page)
        await page.locator('[data-testid="out-of-date-banner"]').waitFor()
        await page.click('[data-testid="bring-up-to-date"]')

        await page.waitForSelector('[data-testid="interview-update-intro"]')
        assert.match(await page.textContent('[data-testid="interview-update-count"]'), /^1 Field on SOAP is Out of date/)
        await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
        await page.click('[data-testid="interview-start"]')
        await page.waitForSelector('[data-testid="interview-round"]')
        assert.deepEqual(await cardIds(page), ['update:background.problem'])
        await choose(page, 'update:background.problem', 'Keep')
        await page.click('[data-testid="round-submit"]')
        await page.waitForSelector('[data-testid="update-ready"]')
        await page.click('[data-testid="update-save"]')
        await page.waitForSelector('[data-testid="update-saved"]')

        const read = (path) =>
          page.evaluate(
            async ({ path }) => {
              const { readTextFile } = await import('/lib/localWorkspace.js')
              const root = await navigator.storage.getDirectory()
              for await (const [name, handle] of root.entries()) {
                if (!name.startsWith('local-ws-')) continue
                try {
                  return await readTextFile(handle, path)
                } catch {
                  // not this one
                }
              }
              return null
            },
            { path }
          )
        const log = parseYAML(await read('gantry-workspace/local-update/interview/shape.yaml'))
        const entry = log.entries.find((e) => e.kind === 'source-update')
        assert.deepEqual([entry.source, entry.outcome, entry.fields], ['client-brief', 'keep', ['background.problem']])
        assert.equal(log.entries.find((e) => e.kind === 'returned-to-draft'), undefined, 'nothing was changed, so the agreed Module stays agreed')
        const module = await read('gantry-workspace/local-update/modules/background.md')
        assert.match(module, /status: agreed/)
        assert.match(module, /Median time to payment is 12\.4 days \[Client brief, p\. 1\]\(source:client-brief\)/)

        // Answered and saved: the flag is gone.
        await page.click('[data-testid="update-back-to-editor"]')
        await page.waitForSelector('.module')
        await openPanel(page)
        await page.waitForTimeout(800)
        assert.equal(await page.locator('[data-testid="out-of-date-banner"]').count(), 0)
        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  )
})

// ---------- Azure DevOps and GitHub ----------
// Beta is the current Stage and Alpha is approved. `ms` (shared) can be edited on Beta, so a change to it is carried forward from Alpha; `ma`
// belongs to Alpha alone, so the card offers a re-open when ADR-0026 allows it, and logs an open question naming the blocker when it does not.

const REMOTE_SLUG = 'remote-pair'
const REMOTE_ROOT = `gantry-workspace/${REMOTE_SLUG}`
const REMOTE_PROVIDERS = [
  {
    name: 'Azure DevOps',
    provider: 'azure-devops',
    kind: 'azureDevOps',
    location: (ctx) => ({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, baseUrl: ctx.providerBaseUrl }),
    client: (ctx) => createAzureDevOpsClient({ organization: ORGANIZATION, project: PROJECT, repository: REPOSITORY, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
  },
  {
    name: 'GitHub',
    provider: 'github',
    kind: 'github',
    location: (ctx) => ({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, baseUrl: ctx.providerBaseUrl }),
    client: (ctx) => createGitHubClient({ owner: GITHUB_OWNER, repository: GITHUB_REPOSITORY, pat: ctx.pat, baseUrl: ctx.providerBaseUrl }),
  },
]

for (const spec of REMOTE_PROVIDERS) {
  test(`${spec.name}: a change to an approved Stage's Field is carried forward to the current Stage, one only that Stage can change becomes an open question naming the blocker, and it lands on the Stage's branch`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'gantry-298-remote-'))
    const definitionsDir = join(root, 'definitions')
    const instancesDir = join(root, 'instances')
    try {
      writePair(definitionsDir)
      const alphaLog = serializeDecisionsLog({
        version: 1,
        stage: 'a',
        status: [],
        fields: { 'ms.body': { drafted: '2026-11-01T10:00:00.000Z', inputs: [{ source: 'brief', title: 'Brief', range: null, fingerprint: 'x' }], entries: [] } },
        entries: [],
      })
      const files = {
        [`/${REMOTE_ROOT}/instance.yaml`]: `definition: pair\nslug: ${REMOTE_SLUG}\nstage: b\ndefinitionVersion: 1\n`,
        [`/${REMOTE_ROOT}/modules/ma.md`]: pairModuleText('ma', 'Alpha claims [Brief, p. 1](source:brief).'),
        [`/${REMOTE_ROOT}/modules/mb.md`]: pairModuleText('mb', 'Beta notes.'),
        [`/${REMOTE_ROOT}/modules/ms.md`]: pairModuleText('ms', 'Shared claims, drafted from the Brief.'),
        [`/${REMOTE_ROOT}/interview/a.yaml`]: alphaLog,
      }
      await withFakeAnthropic(redraftScript, (aiBase, posts) =>
        withRunningServerForProvider(spec.provider, { options: { instancesDir, definitionsDir, allowPrivateAiUrls: true }, fakeServerOptions: { files } }, async (ctx) => {
          registerInstance(REMOTE_SLUG, { kind: spec.kind, ...spec.location(ctx) }, { instancesDir })
          const client = spec.client(ctx)
          const browser = await launchBrowser()
          try {
            const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
            page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
            const pageErrors = []
            page.on('pageerror', (err) => pageErrors.push(err.message))
            await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), ctx.pat)
            await seedProviders(page, aiBase)

            await page.goto(`${ctx.gantryBase}/instance/${REMOTE_SLUG}`)
            const panel = await openPanel(page)
            await upload(panel, 'Brief.md', '# Brief\n\nAlpha claims take 12 days.\n')
            await panel.locator('[data-testid="source-replaces"]').selectOption({ label: 'This replaces… Brief' })
            await upload(panel, 'Brief v2.md', '# Brief v2\n\nAlpha claims take 11 days.\n')
            await showFields(page)
            await page.waitForSelector('[data-testid="out-of-date-banner"]')
            assert.match(await page.locator('[data-testid="out-of-date-line"]').textContent(), /^2 Fields drew on Brief, now replaced by Brief v2:/)
            await page.click('[data-testid="bring-up-to-date"]')

            // A remote workspace is written on its current Stage only, so the round is on Beta and has a card for each of the two Fields.
            await page.waitForSelector('[data-testid="interview-update-intro"]')
            assert.equal(await page.locator('[data-testid="interview-blocked"]').count(), 0)
            await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
            await page.click('[data-testid="interview-start"]')
            await page.waitForSelector('[data-testid="interview-round"]')
            assert.equal(posts.length, 0)
            assert.deepEqual(await cardIds(page), ['update:ma.body', 'update:ms.body'])

            // The shared Module is carried forward: the card says it changes approved content, re-approved with Beta.
            const shared = page.locator('[data-testid="interview-card"][data-card-id="update:ms.body"]')
            assert.match(await shared.locator('[data-testid="update-landing"]').textContent(), /Alpha is approved\. A change is carried forward: it is made on Beta/)
            assert.match(await shared.locator('[data-testid="update-landing"]').textContent(), /re-approved with Beta/)
            assert.deepEqual(await chosen(page, 'update:ms.body'), ['Redraft'])

            // Alpha's own Module cannot be edited on Beta. The Source documents were committed on Beta's branch, so Beta is in progress and Alpha
            // cannot be re-opened (ADR-0026): the card says so, and an open question is recommended.
            const own = page.locator('[data-testid="interview-card"][data-card-id="update:ma.body"]')
            assert.deepEqual(await own.locator('[data-testid="card-option"]').evaluateAll((els) => els.map((el) => el.dataset.option)), ['Log an open question', 'Leave it flagged'])
            assert.deepEqual(await chosen(page, 'update:ma.body'), ['Log an open question'])
            assert.match(await own.locator('[data-testid="card-why"]').textContent(), /Beta is already in progress/)

            await page.click('[data-testid="round-submit"]')
            await page.waitForSelector('[data-testid="interview-card"][data-card-type="change"]')
            assert.match(posts[0].raw, /ms\.body \([^)]*\): REDRAFT/)
            assert.doesNotMatch(posts[0].raw, /ma\.body \([^)]*\): REDRAFT/)
            await choose(page, 'change:ms.body', "Use the AI's version")
            await page.click('[data-testid="round-submit"]')
            await page.waitForSelector('[data-testid="update-ready"]')
            await page.click('[data-testid="update-save"]')
            await page.waitForSelector('[data-testid="update-saved"]')
            assert.equal(await page.locator('[data-testid="update-reopen"]').count(), 0, 'no re-open was chosen')

            // On the Provider: the change is on Beta's branch, main is untouched, and Alpha's Module was not written.
            const branch = stageBranchName(REMOTE_SLUG, 'b')
            assert.match(await client.getFileContent(`${REMOTE_ROOT}/modules/ms.md`, { branch }), /Redrafted ms\.body from the new brief/)
            assert.match(await client.getFileContent(`${REMOTE_ROOT}/modules/ms.md`, { branch: 'main' }), /Shared claims, drafted from the Brief/)
            assert.match(await client.getFileContent(`${REMOTE_ROOT}/modules/ma.md`, { branch }), /Alpha claims \[Brief, p\. 1\]\(source:brief\)/)
            const log = parseYAML(await client.getFileContent(`${REMOTE_ROOT}/interview/b.yaml`, { branch }))
            const carried = log.entries.find((e) => e.kind === 'source-update' && e.fields[0] === 'ms.body')
            assert.deepEqual([carried.outcome, carried.stage, carried.source], ['redraft', 'a', 'brief'], 'the entry names the approved Stage the Field belongs to')
            const question = log.entries.find((e) => e.kind === 'open-question')
            assert.deepEqual(question.fields, ['ma.body'])
            assert.ok(log.entries.some((e) => e.kind === 'source-update' && e.fields[0] === 'ma.body' && e.outcome === 'open-question'))
            assert.deepEqual(pageErrors, [])
          } finally {
            await browser.close()
          }
        })
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

for (const spec of REMOTE_PROVIDERS) {
  test(`${spec.name}: when ADR-0026 allows it the card offers to re-open the approved Stage, and re-opening it brings the round back on that Stage`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'gantry-298-reopen-'))
    const definitionsDir = join(root, 'definitions')
    const instancesDir = join(root, 'instances')
    try {
      writePair(definitionsDir)
      // The documents are already in the repository on main, so Beta (the current Stage) has no branch yet and Alpha can be re-opened.
      const entry = (id, filename, over) => ({ id, filename, title: filename.replace(/\.md$/, ''), uploadedBy: '', size: 20, text: sourceTextRef(filename), ...over })
      const manifest = stringifySourceManifest([
        entry('brief', 'Brief.md', { uploadedAt: '2026-11-01T09:00:00.000Z' }),
        entry('brief-v2', 'Brief v2.md', { uploadedAt: '2026-11-02T09:00:00.000Z', replaces: 'brief' }),
      ])
      const files = {
        [`/${REMOTE_ROOT}/instance.yaml`]: `definition: pair\nslug: ${REMOTE_SLUG}\nstage: b\ndefinitionVersion: 1\n`,
        [`/${REMOTE_ROOT}/modules/ma.md`]: pairModuleText('ma', 'Alpha claims [Brief, p. 1](source:brief).'),
        [`/${REMOTE_ROOT}/modules/mb.md`]: pairModuleText('mb', 'Beta notes.'),
        [`/${REMOTE_ROOT}/modules/ms.md`]: pairModuleText('ms', 'Shared claims, drafted from the Brief.'),
        [`/${REMOTE_ROOT}/interview/a.yaml`]: serializeDecisionsLog({
          version: 1,
          stage: 'a',
          status: [],
          fields: { 'ms.body': { drafted: '2026-11-01T10:00:00.000Z', inputs: [{ source: 'brief', title: 'Brief', range: null, fingerprint: 'x' }], entries: [] } },
          entries: [],
        }),
        [`/${REMOTE_ROOT}/sources/manifest.yaml`]: manifest,
        [`/${REMOTE_ROOT}/sources/Brief.md`]: '# Brief\n\nAlpha claims take 12 days.\n',
        [`/${REMOTE_ROOT}/sources/Brief v2.md`]: '# Brief v2\n\nAlpha claims take 11 days.\n',
        [`/${REMOTE_ROOT}/${sourceTextPath('Brief.md')}`]: '# Brief\n\nAlpha claims take 12 days.\n',
        [`/${REMOTE_ROOT}/${sourceTextPath('Brief v2.md')}`]: '# Brief v2\n\nAlpha claims take 11 days.\n',
      }
      await withFakeAnthropic(redraftScript, (aiBase, posts) =>
        withRunningServerForProvider(spec.provider, { options: { instancesDir, definitionsDir, allowPrivateAiUrls: true }, fakeServerOptions: { files } }, async (ctx) => {
          registerInstance(REMOTE_SLUG, { kind: spec.kind, ...spec.location(ctx) }, { instancesDir })
          const client = spec.client(ctx)
          const browser = await launchBrowser()
          try {
            const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
            page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
            const pageErrors = []
            page.on('pageerror', (err) => pageErrors.push(err.message))
            await page.addInitScript((pat) => localStorage.setItem('gantry:ado-pat', pat), ctx.pat)
            await seedProviders(page, aiBase)

            await page.goto(`${ctx.gantryBase}/instance/${REMOTE_SLUG}`)
            await page.waitForSelector('[data-testid="out-of-date-banner"]')
            assert.equal(await client.branchExists(stageBranchName(REMOTE_SLUG, 'b')), false, 'nothing has started Beta')
            await page.click('[data-testid="bring-up-to-date"]')
            await page.waitForSelector('[data-testid="interview-update-intro"]')
            await page.waitForSelector('[data-testid="interview-start"]:not([disabled])')
            await page.click('[data-testid="interview-start"]')
            await page.waitForSelector('[data-testid="interview-round"]')

            // Alpha's own Module: re-open is offered and recommended. The shared Module is kept as it is (the stand-in has nothing to draft).
            const own = page.locator('[data-testid="interview-card"][data-card-id="update:ma.body"]')
            assert.deepEqual(await own.locator('[data-testid="card-option"]').evaluateAll((els) => els.map((el) => el.dataset.option)), ['Re-open Alpha', 'Log an open question'])
            assert.deepEqual(await chosen(page, 'update:ma.body'), ['Re-open Alpha'])
            assert.match(await own.locator('[data-testid="card-why"]').textContent(), /Alpha is approved and .* cannot be edited on Beta, but Gantry allows Alpha to be re-opened/)
            await choose(page, 'update:ms.body', 'Keep')
            await page.click('[data-testid="round-submit"]')
            await page.waitForSelector('[data-testid="update-ready"]')
            assert.equal(posts.length, 0)

            // Saving would start Beta and so stop Alpha being re-opened: the card puts the choice to the architect, and the Save is the lesser button.
            await page.waitForSelector('[data-testid="update-reopen-button"]')
            assert.match(await page.textContent('[data-testid="update-reopen-note"]'), /Saving this round starts Beta \(it gets a branch\),\s+and while Beta is in progress Alpha cannot be re-opened \(ADR-0026\)/)
            assert.match(await page.textContent('[data-testid="update-save"]'), /Save the other answers instead/)
            assert.equal(await client.branchExists(stageBranchName(REMOTE_SLUG, 'b')), false, 'nothing has been saved')
            await page.click('[data-testid="update-reopen-button"]')

            // Alpha is the current Stage again. Nothing was saved, so the round asks about both Fields on Alpha, where both can now be changed in place.
            await page.waitForFunction(() => /Alpha/.test(document.querySelector('.interview-rail .interview-instance + .cite')?.textContent ?? ''))
            await page.waitForSelector('[data-testid="interview-update-count"]')
            assert.match(await page.textContent('[data-testid="interview-update-count"]'), /^2 Fields on Alpha are Out of date/)
            assert.equal(parseYAML(await client.getFileContent(`${REMOTE_ROOT}/instance.yaml`, { branch: 'main' })).stage, 'a')
            assert.equal(await client.branchExists(stageBranchName(REMOTE_SLUG, 'a')), true)
            assert.equal(await client.branchExists(stageBranchName(REMOTE_SLUG, 'b')), false, 'Beta was never started')
            assert.deepEqual(pageErrors, [])
          } finally {
            await browser.close()
          }
        })
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

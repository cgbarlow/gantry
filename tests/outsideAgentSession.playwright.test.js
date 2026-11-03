import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { createInstance } from '../lib/instance.js'

// #307 (docs/adr/0067): what an architect sees in the browser of a session an outside agent paused. The agent's entries are labelled
// "recorded by an outside agent" in the read-only Decisions log panel, and the Interview page recaps the session from the committed
// log, exactly as it does for a session paused in a browser. (The routes and the tools are tested in tests/outsideAgentRoutes.test.js
// and mcp-server/test.)

const SLUG = 'my-initiative'

async function withPage(fn) {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } })
    page.setDefaultTimeout(Math.max(DEFAULT_TIMEOUT, 30_000))
    const pageErrors = []
    page.on('pageerror', (err) => pageErrors.push(err.message))
    await fn(page, pageErrors)
    assert.deepEqual(pageErrors, [])
  } finally {
    await browser.close()
  }
}

test('a session an outside agent paused: its entries are labelled in the Decisions log panel and the Interview page recaps it from the log', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-307-'))
  try {
    createInstance('design', SLUG, { instancesDir, definitionVersion: 3 })
    await withRunningServer({ slug: SLUG, instancesDir }, (base) =>
      withPage(async (page) => {
        const api = (method, path, body) =>
          fetch(`${base}${path}${path.includes('?') ? '&' : '?'}slug=${SLUG}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
        const instance = await (await api('GET', '/api/instance')).json()
        const stage = instance.stage.id
        const saved = await api('PUT', '/api/instance/modules', {
          modules: { background: { fields: { problem: 'Claims handling is slow and manual.' } } },
          baseVersion: instance.stageVersion,
          session: { id: 's-agent1', runUntil: stage, state: 'paused', model: 'claude-opus-4-1', who: 'a.architect' },
          entries: [
            { kind: 'answer', header: 'Scope', question: 'Is claims handling in scope?', answer: ['Yes'], fields: ['background.problem'] },
            { kind: 'fact', words: 'The sponsor is Pat, from Finance.', fields: ['background.problem'] },
            { kind: 'open-question', question: 'Which card schemes?', why: 'The brief does not say.' },
          ],
        })
        assert.equal(saved.status, 200, await saved.clone().text())

        // The editor's read-only Decisions log panel says whose account each entry is.
        await page.goto(`${base}/instance/${SLUG}`)
        await page.waitForSelector('[data-testid="decisions-log-panel"]')
        assert.equal((await page.textContent('[data-testid="decisions-log-count"]')).trim(), '3')
        await page.click('[data-testid="decisions-history-toggle"]')
        const metas = await page.locator('[data-testid="decisions-history"] [data-testid="decisions-entry"] .dl-meta').allTextContents()
        assert.equal(metas.length, 3)
        for (const meta of metas) assert.match(meta, /recorded by an outside agent/)
        assert.match(await page.textContent('[data-testid="decisions-latest"]'), /Is claims handling in scope\?/)

        // The Interview page recaps the session the way it does one that was paused in a browser.
        await page.goto(`${base}/instance/${SLUG}?interview=1`)
        await page.waitForSelector('[data-testid="interview-resume-recap"]')
        assert.match(await page.textContent('[data-testid="interview-resume-recap"]'), /Resuming .*: 2 decisions, 1 open question/)
      })
    )
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

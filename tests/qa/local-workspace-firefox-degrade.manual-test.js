import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { firefox } from 'playwright'
import { withRunningServer } from '../helpers/lifecycle.js'

// WI #299 (A8) — cross-browser matrix, automated portion. The rest of the
// suite (tests/wizard-local-workspace.playwright.test.js et al.) exercises
// gantry's unsupported-browser UI by *simulating* a missing
// `showDirectoryPicker` inside Chromium (`delete window.showDirectoryPicker`
// before the app's `isSupported` check runs) — that proves the app's own
// feature-detection branch is correct, but not that a real non-Chromium
// engine actually lacks the API. This file launches a REAL Firefox and
// asserts the same thing against the genuine engine, no simulation.
//
// Why this is meaningful evidence for Safari too, without a real Safari:
// gantry's `web/lib/localWorkspace.js` `isSupported` check is a plain
// `typeof window.showDirectoryPicker === 'function'` feature-detect, not a
// user-agent sniff (confirmed by reading that file) — so any engine without
// the API, WebKit/Safari included, is provably routed through the identical
// code path this test already exercises against a real engine. What this
// file does NOT cover — and what genuinely needs a human or a CI image with
// the missing system libraries (libgtk-4, libgstgl-1.0, etc. — this sandbox
// has neither root nor those packages) — is a real WebKit/Safari launch, and
// anything requiring native OS chrome: the actual `showDirectoryPicker()`
// folder-picker dialog, permission-prompt UX, and handle persistence across
// a real browser restart. See docs/qa/local-workspaces-browser-matrix.md.
//
// DELIBERATELY named *.manual-test.js, not *.playwright.test.js: it needs a
// real Firefox binary (`npx playwright install firefox`) that the project's
// ContainerFile does not install (it installs Chromium only), so this is
// excluded from `npm run test:e2e`'s `tests/*.playwright.test.js` glob and
// from CI on purpose — wiring it in permanently would need a ContainerFile
// change, a call the security-review ticket left for a human, not this
// script. Run it on demand with:
//   npx playwright install firefox   # once, if not already installed
//   node --test tests/qa/local-workspace-firefox-degrade.manual-test.js

function withServer(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-wi299-firefox-'))
  return withRunningServer({ instancesDir }, async (gantryBase) => {
    try {
      await fn({ gantryBase })
    } finally {
      rmSync(instancesDir, { recursive: true, force: true })
    }
  })
}

test('real Firefox: showDirectoryPicker is genuinely absent, and gantry degrades to the disabled-with-message state', async () => {
  await withServer(async ({ gantryBase }) => {
    const browser = await firefox.launch()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(15_000)
      await page.addInitScript(() => localStorage.setItem('gantry:advancedMode', 'true'))
      await page.goto(`${gantryBase}/new-workspace`)
      await page.waitForSelector('h2:has-text("New Workspace")')

      // The API is genuinely missing in this engine — not simulated.
      const hasFSA = await page.evaluate(() => typeof window.showDirectoryPicker)
      assert.equal(hasFSA, 'undefined', 'real Firefox is expected to have no showDirectoryPicker')

      // Same unsupported-browser UI the Chromium-simulated test asserts on
      // (tests/wizard-local-workspace.playwright.test.js) — proving the
      // app's feature-detect branch, not a UA sniff, is what's driving this.
      const localToggle = page.getByRole('button', { name: 'Local', exact: true })
      assert.equal(await localToggle.count(), 1)
      await localToggle.click()

      await page.waitForSelector('#local-unsupported')
      assert.match(
        await page.locator('#local-unsupported').textContent(),
        /Local workspaces need Chrome or Edge/
      )
      const actionBtn = page.locator('.wizard-field button.btn.primary', { hasText: /local workspace/i })
      assert.equal(await actionBtn.first().isDisabled(), true)

      // Server-hosted still works — Firefox is a fully supported browser
      // for every part of gantry that isn't File-System-Access-API-gated.
      await page.getByRole('button', { name: 'Server-hosted', exact: true }).click()
      await page.getByRole('button', { name: 'Register new workspace', exact: true }).click()
      await page.waitForSelector('#ws-organization')
    } finally {
      await browser.close()
    }
  })
})

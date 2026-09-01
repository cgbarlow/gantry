import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser } from '/home/dev/gantry/.claude/worktrees/agent-aa8b9aa104d875041/tests/helpers/launchBrowser.js'
import { withRunningServer } from '/home/dev/gantry/.claude/worktrees/agent-aa8b9aa104d875041/tests/helpers/lifecycle.js'

const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
try {
  await withRunningServer({ instancesDir }, async (base) => {
    const browser = await launchBrowser()
    const page = await browser.newPage()
    page.on('pageerror', (err) => console.log('PAGEERROR:', err.message))
    page.on('console', (msg) => console.log('CONSOLE:', msg.type(), msg.text()))
    page.on('requestfailed', (req) => console.log('REQFAIL:', req.url(), req.failure()?.errorText))
    page.on('response', (res) => { if (!res.ok()) console.log('BADRESP:', res.status(), res.url()) })
    const t0 = Date.now()
    await page.goto(`${base}/settings`)
    await page.waitForTimeout(3000)
    console.log('elapsed ms', Date.now() - t0)
    console.log('BODY:', (await page.locator('body').innerText()).slice(0, 1000))
    await browser.close()
  })
} finally {
  rmSync(instancesDir, { recursive: true, force: true })
}

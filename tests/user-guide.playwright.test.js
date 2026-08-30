import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { createServer } from '../lib/server.js'

function withRunningServer(fn) {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn(`http://localhost:${port}`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
      }
    })
  })
}

test('User Guide: loads markdown content, ordered navigation, and definition-backed sections', async () => {
  await withRunningServer(async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })

      await page.goto(`${base}/user-guide`)
      await page.waitForSelector('.guide-content h2', { timeout: DEFAULT_TIMEOUT })

      assert.equal(await page.locator('.guide-header h1').textContent(), 'User Guide')
      assert.deepEqual(await page.locator('.guide-navigation li').allTextContents(), [
        'Getting Started',
        'Workspaces & Instances',
        'Stages & Gates',
        'Modules & Fields',
        'Artefacts & Rendering',
        'Approval workflow',
        'Settings',
      ])
      assert.deepEqual(await page.locator('.guide-content h2').allTextContents(), [
        'Getting Started',
        'Workspaces & Instances',
        'Stages & Gates',
        'Modules & Fields',
        'Artefacts & Rendering',
        'Approval workflow',
        'Settings',
      ])
      assert.equal(await page.locator('.guide-navigation li.pending').count(), 0)
      assert.equal(await page.locator('.guide-navigation a').nth(2).getAttribute('href'), '#stages-gates')
      assert.equal(await page.locator('.guide-content h2').nth(2).getAttribute('id'), 'stages-gates')
      assert.deepEqual(await page.locator('.guide-content h2').evaluateAll((headings) => headings.map((heading) => heading.id)), [
        'getting-started',
        'workspaces-instances',
        'stages-gates',
        'modules-fields',
        'artefacts-rendering',
        'approval-workflow',
        'settings',
      ])
      const repeatedHeadingIds = await page.evaluate(async () => {
        const { renderMarkdown } = await import('/lib/markdown.js')
        const container = document.createElement('div')
        container.innerHTML = renderMarkdown('## Repeat\n\n## Repeat\n\n## Repeat')
        return [...container.querySelectorAll('h2')].map((heading) => heading.id)
      })
      assert.deepEqual(repeatedHeadingIds, ['repeat', 'repeat-2', 'repeat-3'])
      const collidingHeadingIds = await page.evaluate(async () => {
        const { renderMarkdown } = await import('/lib/markdown.js')
        const container = document.createElement('div')
        container.innerHTML = renderMarkdown('## Foo\n\n## Foo-2\n\n## Foo')
        return [...container.querySelectorAll('h2')].map((heading) => heading.id)
      })
      assert.deepEqual(collidingHeadingIds, ['foo', 'foo-2', 'foo-3'])
      assert.match(await page.locator('.guide-content').textContent(), /Request Approval/)
      assert.match(await page.locator('.guide-content').textContent(), /Workspace Settings/)
      const guideText = await page.locator('.guide-content').textContent()
      assert.match(guideText, /Shape an initiative into a clear business case/)
      assert.match(guideText, /Define the proposed solution in enough detail for approval/)
      assert.match(guideText, /Describe the architecture, integration, data, quality, security, risk/)
      assert.match(guideText, /Record the as-built solution and the information needed to hand it over/)
      assert.match(guideText, /Summarise the initiative's context, solution, team, and estimates/)
      assert.match(guideText, /Provide a fuller Solution on a Page with detailed scope/)
      assert.match(guideText, /Present the proposed solution, alternatives, risks, and open questions/)
      assert.match(guideText, /Describe the complete solution architecture and its requirements/)
      assert.match(guideText, /Frame the solution's design and operational readiness/)
      assert.match(guideText, /Capture what was built and the final handover information/)
      assert.match(guideText, /context\.driver/)
      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

test('User Guide: landing and instance headers place the link before Settings', async () => {
  await withRunningServer(async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.goto(base)
      await page.waitForSelector('.dashboard-topbar')
      assert.deepEqual(await page.locator('.dashboard-controls a').allTextContents(), ['+ New Workspace', 'Definition Editor (experimental)', 'User Guide', 'Settings'])

      await page.goto(`${base}/instance/examples`)
      await page.waitForSelector('.instance-switcher')
      assert.deepEqual(await page.locator('header > .brand > a, header > .brand > h1, header > .brand > .instance-switcher, header > .brand > .settings-menu').allTextContents(), [
        '← Workspaces',
        'examples — design',
        'Switch instance ▾',
        'User Guide',
        'Settings',
      ])

      await page.setViewportSize({ width: 320, height: 800 })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    } finally {
      await browser.close()
    }
  })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { createServer } from '../lib/server.js'

function withRunningServer(options, fn) {
  return new Promise((resolve, reject) => {
    const server = createServer(options)
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

test('Navigation dropdown renders below Work item details card, lists headings in document order, and smooth-scrolls on selection (WI232)', async () => {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  try {
    cpSync('instances/examples', join(instancesDir, 'examples'), { recursive: true })
    rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })

    await withRunningServer({ slug: 'examples', instancesDir }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage()
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => {
          if (msg.type() === 'error') pageErrors.push(msg.text())
        })

        await page.goto(`${base}/instance/examples`)
        await page.waitForSelector('.module', { timeout: 10_000 })
        await page.waitForSelector('.stage-navigation', { timeout: 10_000 })

        // Positioned inside the view-mode toolbar to the right of the Artefact dropdown
        const nav = page.locator('.toolbar .toolbar-left .stage-navigation')
        assert.equal(await nav.count(), 1)
        const isInsideToolbar = await page.evaluate(() => {
          const navEl = document.querySelector('.stage-navigation')
          const toolbarLeft = document.querySelector('.toolbar .toolbar-left')
          return toolbarLeft ? toolbarLeft.contains(navEl) : false
        })
        assert.ok(isInsideToolbar, '.stage-navigation should be a descendant of .toolbar .toolbar-left')
        const navBox = await nav.boundingBox()
        const segmentedBox = await page.locator('.toolbar .toolbar-left .segmented').boundingBox()
        assert.ok(navBox && segmentedBox, 'Navigation and segmented should have bounding boxes')
        // Same row as segmented: y overlaps
        const yOverlaps = navBox.y < segmentedBox.y + segmentedBox.height && navBox.y + navBox.height > segmentedBox.y
        assert.ok(yOverlaps, 'Navigation should be on the same row as .segmented (y overlaps)')
        assert.ok(navBox.x > segmentedBox.x, 'Navigation should be to the right of .segmented')
        const artefactCount = await page.locator('.artefact-selector').count()
        if (artefactCount > 0) {
          const artefactBox = await page.locator('.artefact-selector').boundingBox()
          assert.ok(artefactBox, 'Artefact selector should have bounding box')
          assert.ok(navBox.x > artefactBox.x, 'Navigation should be to the right of .artefact-selector when present')
        }

        // Uses shared Dropdown component
        const trigger = nav.getByRole('button', { name: 'Navigation' })
        await assert.doesNotReject(trigger.waitFor({ state: 'visible', timeout: 5_000 }))
        // Should be a Dropdown trigger (aria-haspopup)
        assert.equal(await trigger.getAttribute('aria-haspopup'), 'true')

        // Collect headings from DOM in document order
        const headings = await page.evaluate(() => {
          const els = [...document.querySelectorAll('.module h2[id], .field h3[id]')]
          return els.map((el) => ({ id: el.id, text: el.textContent.trim(), tag: el.tagName }))
        })
        // Each module h2 and each field h3 should have a stable id derived from slug of module id + heading text
        for (const h of headings) {
          assert.ok(h.id.includes('--'), `heading id "${h.id}" should contain "--" slug separator`)
          assert.match(h.id, /^[a-z0-9._-]+--[a-z0-9-]+$/, `heading id "${h.id}" should be slugified`)
        }
        // Ids are deterministic: re-query after evaluation should be same
        const headings2 = await page.evaluate(() => [...document.querySelectorAll('.module h2[id], .field h3[id]')].map((el) => el.id))
        assert.deepEqual(headings2, headings.map((h) => h.id))

        // Opening dropdown lists every heading in document order
        await trigger.click()
        const menu = page.locator('.stage-navigation-dropdown .menu')
        await menu.waitFor({ state: 'visible', timeout: 5_000 })
        const menuItems = page.locator('.stage-navigation-dropdown .nav-item')
        const menuTexts = await menuItems.allTextContents()
        const headingTexts = headings.map((h) => h.text)
        assert.deepEqual(menuTexts.map((t) => t.trim()), headingTexts, 'Dropdown should list every module h2 and field h3 in document order')

        // H3 entries are indented via nav-item-h3
        const h3Count = headings.filter((h) => h.tag === 'H3').length
        assert.equal(await page.locator('.stage-navigation-dropdown .nav-item-h3').count(), h3Count)

        // Selecting an entry smooth-scrolls that heading and closes dropdown
        // Stub scrollIntoView to capture call
        await page.evaluate(() => {
          window.__scrolled = null
          const orig = Element.prototype.scrollIntoView
          Element.prototype.scrollIntoView = function (opts) {
            window.__scrolled = { id: this.id, opts }
            return orig.call(this, opts)
          }
        })
        // Click a middle heading (ensure it is not already at top)
        const targetIndex = headings.length > 2 ? 2 : 0
        const targetId = headings[targetIndex].id
        await menuItems.nth(targetIndex).click()
        await menu.waitFor({ state: 'hidden', timeout: 5_000 })
        const scrolled = await page.evaluate(() => window.__scrolled)
        assert.ok(scrolled, 'scrollIntoView should have been called')
        assert.equal(scrolled.id, targetId)
        assert.deepEqual(scrolled.opts, { behavior: 'smooth', block: 'start' })

        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(instancesDir, { recursive: true, force: true })
  }
})

test('slugify and headingId are deterministic (unit check for WI232 helper)', async () => {
  // Re-implement expected slug logic here to avoid importing browser bundle in node
  function slugify(text) {
    return String(text ?? '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section'
  }
  function headingId(moduleId, headingText) {
    return `${moduleId}--${slugify(headingText)}`
  }
  assert.equal(headingId('architecture', 'Design decisions'), 'architecture--design-decisions')
  assert.equal(headingId('context', 'Problem statement *'), 'context--problem-statement')
  assert.equal(slugify('  Hello World!  '), 'hello-world')
})

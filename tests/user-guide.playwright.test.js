import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
        'Definition Reference Guide',
      ])
      assert.deepEqual(await page.locator('.guide-content h2').allTextContents(), [
        'Getting Started',
        'Workspaces & Instances',
        'Stages & Gates',
        'Modules & Fields',
        'Artefacts & Rendering',
        'Approval workflow',
        'Settings',
        'Definition Reference Guide',
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
        'definition-reference-guide',
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
      // The concept sections describe Gantry at a high level; the definition-specific
      // detail lives only in the Definition Reference Guide section, which is authored
      // by hand rather than generated from the definition.
      assert.doesNotMatch(guideText, /Its exit gate is/)
      assert.doesNotMatch(guideText, /context\.driver/)
      // New subsections added in WI222 second pass
      const h3Texts = await page.locator('.guide-content h3').allTextContents()
      // Definition Reference Guide: one sub-page per definition, with a mapping table
      // per reference document and the field-by-stage table.
      assert.ok(h3Texts.includes('Contoso Solution Design'))
      const h4Texts = await page.locator('.guide-content h4').allTextContents()
      for (const doc of [
        'Solution on a Page (SOAP)',
        'Full Solution on a Page (Full SOAP)',
        'High Level Design (HLD)',
        'Solution Architecture Document (SAD)',
        'Solution Support Architecture Document (SSAD)',
        'As-built',
        'Fields by stage',
      ]) {
        assert.ok(h4Texts.includes(doc), `expected a "${doc}" sub-section in the Definition Reference Guide`)
      }
      assert.ok((await page.locator('.guide-content table').count()) >= 8, 'expected the reference-mapping and field-by-stage tables')
      assert.match(guideText, /introduction\.in-scope/)
      assert.ok(h3Texts.includes('Choosing a definition version'))
      assert.ok(h3Texts.includes('Dashboard PR status badge'))
      assert.ok(h3Texts.includes('Archive and restore'))
      assert.ok(h3Texts.some((t) => t.includes('Definition versions and the Definitions page')))
      assert.ok(h3Texts.includes('The editor toolbar'))
      assert.ok(h3Texts.includes('Rendering'))
      assert.match(guideText, /Definitions page/)
      assert.match(guideText, /Outline.*Map/s)
      assert.match(guideText, /Show commit history/)
      assert.match(guideText, /Navigation/)
      assert.match(guideText, /PR OPEN/)

      // Every image inside the guide has a non-empty src and serves a PNG
      const imgCount = await page.locator('.guide-content img').count()
      assert.ok(imgCount >= 5, `expected at least 5 guide images, got ${imgCount}`)
      const srcs = await page.locator('.guide-content img').evaluateAll((imgs) => imgs.map((img) => img.getAttribute('src')))
      for (const src of srcs) {
        assert.ok(src && src.trim().length > 0, `image src should be non-empty, got ${JSON.stringify(src)}`)
        assert.ok(src.startsWith('/user-guide-images/'), `image src should be root-relative under /user-guide-images/, got ${src}`)
        assert.match(src, /\.png$/)
        const alt = await page.locator(`.guide-content img[src="${src}"]`).getAttribute('alt')
        assert.ok(alt && alt.trim().length > 0, `image ${src} should have non-empty alt text`)
      }
      for (const src of srcs) {
        const res = await fetch(`${base}${src}`)
        assert.equal(res.status, 200, `fetching ${src} should return 200, got ${res.status}`)
        const ct = res.headers.get('content-type') ?? ''
        assert.match(ct, /image\/png/, `fetching ${src} should return image/png, got ${ct}`)
      }
      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  })
})

test('User Guide: screenshots fit the content column and open in a click-to-expand lightbox', async () => {
  await withRunningServer(async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.setViewportSize({ width: 1024, height: 800 })
      await page.goto(`${base}/user-guide`)
      await page.waitForSelector('.guide-content img', { timeout: DEFAULT_TIMEOUT })

      // Every screenshot and table fits inside its content column, and the page never scrolls sideways.
      const { maxImgWidth, maxTableWidth, contentWidth } = await page.evaluate(() => {
        const imgs = [...document.querySelectorAll('.guide-content img')]
        const tables = [...document.querySelectorAll('.guide-content table')]
        return {
          maxImgWidth: Math.max(...imgs.map((img) => img.getBoundingClientRect().width)),
          maxTableWidth: Math.max(...tables.map((table) => table.getBoundingClientRect().width)),
          contentWidth: document.querySelector('.guide-content').getBoundingClientRect().width,
        }
      })
      assert.ok(maxImgWidth <= contentWidth + 1, `widest image ${maxImgWidth}px should fit content column ${contentWidth}px`)
      assert.ok(maxTableWidth <= contentWidth + 1, `widest table ${maxTableWidth}px should scroll inside content column ${contentWidth}px`)
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
        'the guide page must not scroll horizontally',
      )

      // Clicking a screenshot opens it in the lightbox; Escape closes it.
      await page.locator('.guide-content img').first().click()
      await page.waitForSelector('.guide-lightbox img', { timeout: 5_000 })
      await page.keyboard.press('Escape')
      await page.waitForSelector('.guide-lightbox', { state: 'detached', timeout: 5_000 })
    } finally {
      await browser.close()
    }
  })
})

// WI #356: unlike this file's other tests (doc-only routes, no instance data needed), this one
// needs a real, reachable "examples" instance for its header assertions — the shared no-args
// `withRunningServer` above points at the real (pre-#358, not-yet-migrated) `instances/` directory,
// which this repo's own registry no longer auto-discovers as a bare directory. A scratch copy plus
// startup migration gives this one test real instance data without ever touching the checked-out
// `instances/` directory itself.
function withRunningExamplesServer(fn) {
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-'))
  cpSync('workspaces/examples/kiwi-cover-mutual', join(instancesDir, 'examples'), { recursive: true })
  rmSync(join(instancesDir, 'examples', 'out'), { recursive: true, force: true })
  return new Promise((resolve, reject) => {
    const server = createServer({ instancesDir, migrateWorkspacesOnStart: true })
    server.listen(0, async () => {
      const { port } = server.address()
      try {
        await fn(`http://localhost:${port}`)
        resolve()
      } catch (err) {
        reject(err)
      } finally {
        server.close()
        rmSync(instancesDir, { recursive: true, force: true })
      }
    })
  })
}

test('User Guide: landing and instance headers place the link before Settings', async () => {
  await withRunningExamplesServer(async (base) => {
    const browser = await launchBrowser()
    try {
      const page = await browser.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      await page.goto(base)
      await page.waitForSelector('.dashboard-topbar')
      assert.deepEqual(await page.locator('.dashboard-controls a').allTextContents(), ['+ New Workspace', 'Definitions', 'User Guide', 'Settings'])

      await page.goto(`${base}/instance/examples`)
      await page.waitForSelector('.instance-switcher')
      assert.deepEqual(await page.locator('header > .brand > a, header > .brand > h1, header > .brand > .instance-switcher, header > .brand > .settings-menu').allTextContents(), [
        '← Workspaces',
        // #145: the fixture's own instance.yaml carries `name: Kiwi Cover Mutual` — the header
        // now shows that display name, not the slug ("examples").
        'Kiwi Cover Mutual — design',
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

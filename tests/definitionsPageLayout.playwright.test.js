import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'

// #371: the Definitions page fits a laptop screen. On design v4 at 1440×900 the Map shows all seven of its columns (the four Stages, Not
// in any stage, Instance settings and Interview) and Detailed Design's 16 Modules without scrolling inside the Map, the Library's two
// dropdowns show their whole labels (and carry them as a tooltip), and a wider screen widens the page. Where columns still run off
// the side, a cue on the Map's edge says how many and scrolls to them. Expanding the Map leaves a way back to the Library in plain sight.

async function withDesignV4(fn) {
  const definitionsDir = mkdtempSync(join(tmpdir(), 'defs-371-'))
  const instancesDir = mkdtempSync(join(tmpdir(), 'gantry-instances-371-'))
  try {
    cpSync('definitions/design/4', join(definitionsDir, 'design', '4'), { recursive: true })
    cpSync('definitions/recruitment-onboarding/4', join(definitionsDir, 'recruitment-onboarding', '4'), { recursive: true })
    await withRunningServer({ definitionsDir, instancesDir, migrateWorkspacesOnStart: false }, async (base) => {
      const browser = await launchBrowser()
      try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
        page.setDefaultTimeout(DEFAULT_TIMEOUT)
        const pageErrors = []
        page.on('pageerror', (err) => pageErrors.push(err.message))
        page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(msg.text()) })
        await page.goto(`${base}/definitions`)
        await page.waitForSelector('.defn-viewer', { timeout: 10_000 })
        await page.locator('.defn-switcher [data-dropdown-trigger]').waitFor({ timeout: 10_000 })
        await page.getByRole('button', { name: 'Map', exact: true }).click()
        await page.waitForSelector('.defn-map .defn-map-col', { timeout: 10_000 })
        await fn(page)
        assert.deepEqual(pageErrors, [])
      } finally {
        await browser.close()
      }
    })
  } finally {
    rmSync(definitionsDir, { recursive: true, force: true })
    rmSync(instancesDir, { recursive: true, force: true })
  }
}

// Each Map column's title, and whether the column lies wholly inside the part of the Map on show.
function mapColumns(page) {
  return page.locator('.defn-map').evaluate((map) => {
    const box = map.getBoundingClientRect()
    return [...map.querySelectorAll('.defn-map-col')].map((col) => {
      const r = col.getBoundingClientRect()
      return { title: col.querySelector('.defn-map-col-head').textContent.trim(), onShow: r.left >= box.left - 1 && r.right <= box.left + map.clientWidth + 1 }
    })
  })
}

// Whether a select's chosen label fits inside it, measured with the select's own font, less its padding and the arrow.
function labelFits(select) {
  return select.evaluate((el) => {
    const style = getComputedStyle(el)
    const probe = document.createElement('span')
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${style.font};letter-spacing:${style.letterSpacing}`
    probe.textContent = el.options[el.selectedIndex].text
    document.body.append(probe)
    const textWidth = probe.getBoundingClientRect().width
    probe.remove()
    const room = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 20
    return { text: el.options[el.selectedIndex].text, title: el.title, fits: textWidth <= room }
  })
}

test('At 1440×900 the Map shows all of design v4\'s columns and Detailed Design\'s Modules without scrolling inside it', () =>
  withDesignV4(async (page) => {
    const columns = await mapColumns(page)
    assert.deepEqual(columns.map((c) => c.title.replace(/\s*\d+$/, '')), ['SOAP', 'High-level Design', 'Detailed Design', 'Operational Handover', 'Not in any stage', 'Instance settings', 'Interview'])
    assert.deepEqual(columns.filter((c) => !c.onShow).map((c) => c.title), [], 'every column is on show')
    assert.equal(await page.locator('.defn-map-more').count(), 0, 'nothing is off to the side, so no cue')

    const detailed = page.locator('.defn-map-col', { has: page.locator('.defn-map-col-head', { hasText: 'Detailed Design' }) })
    assert.equal(await detailed.locator('.defn-map-chip').count(), 16)
    const lastChipOnShow = await detailed.locator('.defn-map-chip').last().evaluate((chip) => {
      const map = chip.closest('.defn-map')
      return chip.getBoundingClientRect().bottom <= map.getBoundingClientRect().top + map.clientHeight
    })
    assert.equal(lastChipOnShow, true, 'Detailed Design\'s last Module shows without scrolling inside the Map')
    assert.ok(await page.locator('.defn-map').evaluate((map) => map.clientHeight <= window.innerHeight), 'the Map is never taller than the window, so it can be seen whole')
  }))

test('At 1440×900 the Library\'s definition and version dropdowns show their whole labels, with the label as a tooltip', () =>
  withDesignV4(async (page) => {
    const source = page.locator('.defn-library-source')
    const version = page.getByLabel('Library source version')
    await version.waitFor({ timeout: 10_000 })
    const s = await labelFits(source)
    const v = await labelFits(version)
    assert.equal(s.text, 'Recruitment and Onboarding (recruitment-onboarding)')
    assert.equal(v.text, 'v4 · published')
    assert.deepEqual([s.fits, v.fits], [true, true], 'both labels fit')
    assert.deepEqual([s.title, v.title], [s.text, v.text], 'each dropdown carries its label as a tooltip')
  }))

test('A wider screen widens the page past 1320 px, and the Map still shows every column', () =>
  withDesignV4(async (page) => {
    await page.setViewportSize({ width: 1920, height: 1080 })
    assert.ok((await page.locator('.defn-viewer').boundingBox()).width > 1600, 'the page is no longer held at 1320 px')
    assert.deepEqual((await mapColumns(page)).filter((c) => !c.onShow), [])
  }))

test('When columns run off the side of the Map, a cue on its edge says how many and scrolls to them', () =>
  withDesignV4(async (page) => {
    await page.setViewportSize({ width: 1100, height: 800 })
    const right = page.locator('.defn-map-more-right')
    await right.waitFor({ timeout: 10_000 })
    const hiddenRight = (await mapColumns(page)).filter((c) => !c.onShow).length
    assert.ok(hiddenRight > 0, 'at 1100 px some columns are off to the right (precondition)')
    assert.equal((await right.textContent()).trim(), `${hiddenRight} more column${hiddenRight === 1 ? '' : 's'} →`)
    assert.equal(await page.locator('.defn-map-more-left').count(), 0, 'nothing is off to the left yet')

    // The cue scrolls the Map on, one screenful at a time, until the last column is on show and the cue goes.
    for (let i = 0; i < 5 && (await right.count()); i++) {
      await right.click()
      await page.waitForTimeout(400)
    }
    assert.equal(await right.count(), 0, 'scrolled to the end, the right-hand cue goes')
    const columns = await mapColumns(page)
    assert.equal(columns.at(-1).onShow, true, 'the last column is on show')
    const left = page.locator('.defn-map-more-left')
    await left.waitFor({ timeout: 10_000 })
    const hiddenLeft = columns.filter((c) => !c.onShow).length
    assert.equal((await left.textContent()).trim(), `← ${hiddenLeft} more column${hiddenLeft === 1 ? '' : 's'}`)
  }))

test('With the Map expanded, a button where the panes were brings the detail and Library panes back', () =>
  withDesignV4(async (page) => {
    await page.getByRole('button', { name: 'Expand map' }).click()
    await page.locator('.defn-bottom').waitFor({ state: 'hidden' })
    const restore = page.getByRole('button', { name: 'Show the detail and Library panes' })
    assert.equal(await restore.isVisible(), true)
    await restore.click()
    await page.locator('.defn-library').waitFor({ state: 'visible' })
    assert.equal(await page.getByRole('button', { name: 'Expand map' }).getAttribute('aria-pressed'), 'false')
    assert.equal(await restore.count(), 0, 'the button goes once the panes are back')
  }))

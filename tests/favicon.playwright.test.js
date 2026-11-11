import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { launchBrowser, DEFAULT_TIMEOUT } from './helpers/launchBrowser.js'
import { withRunningServer } from './helpers/lifecycle.js'
import { FAVICON_ICO, ICO_SIZE, ICO_TILE, renderFaviconPng } from '../scripts/render-favicon-ico.mjs'

// #364: the favicon, seen the way a browser sees it — the page's icon link resolving to an image that
// actually loads, the SVG turning light on a dark browser, and /favicon.ico still drawing the same mark.

function withPage(options, fn) {
  return async (base) => {
    const browser = await launchBrowser()
    try {
      const context = await browser.newContext(options)
      const page = await context.newPage()
      page.setDefaultTimeout(DEFAULT_TIMEOUT)
      const pageErrors = []
      page.on('pageerror', (err) => pageErrors.push(err.message))
      page.on('console', (msg) => {
        if (msg.type() === 'error') pageErrors.push(msg.text())
      })
      await fn(page, base)
      assert.deepEqual(pageErrors, [])
    } finally {
      await browser.close()
    }
  }
}

// Every pixel of a PNG (or of the PNG inside an ICO, which an <img> decodes just the same), as RGBA.
async function pixelsOf(page, bytes, type) {
  return page.evaluate(
    async ({ base64, type }) => {
      const blob = await (await fetch(`data:${type};base64,${base64}`)).blob()
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      return { width: bitmap.width, height: bitmap.height, data: [...ctx.getImageData(0, 0, bitmap.width, bitmap.height).data] }
    },
    { base64: Buffer.from(bytes).toString('base64'), type }
  )
}

// The average colour of the mark's strokes: the pixels that are mostly opaque.
function strokeColour({ data }) {
  const sums = [0, 0, 0]
  let count = 0
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue
    sums[0] += data[i]
    sums[1] += data[i + 1]
    sums[2] += data[i + 2]
    count++
  }
  assert.ok(count > 0, 'the mark draws some opaque pixels')
  return sums.map((sum) => Math.round(sum / count))
}

for (const path of ['/', '/user-guide']) {
  test(`the page at ${path} links an icon that resolves and loads (#364)`, async () => {
    await withRunningServer(
      {},
      withPage({}, async (page, base) => {
        await page.goto(`${base}${path}`)
        await page.waitForSelector('h1', { timeout: DEFAULT_TIMEOUT })
        const icon = await page.evaluate(async () => {
          const link = document.querySelector('link[rel="icon"]')
          const img = new Image()
          img.src = link.href
          await img.decode()
          return { href: link.href, type: link.type, width: img.naturalWidth, height: img.naturalHeight }
        })
        assert.equal(icon.href, `${base}/favicon.svg`)
        assert.equal(icon.type, 'image/svg+xml')
        assert.ok(icon.width > 0 && icon.height > 0, `the icon loads as an image (${icon.width}×${icon.height})`)
      })
    )
  })
}

test('the favicon draws dark ink on a light browser and light ink on a dark one (#364)', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    const light = strokeColour(await pixelsOf(page, await renderFaviconPng(browser, { colorScheme: 'light' }), 'image/png'))
    const dark = strokeColour(await pixelsOf(page, await renderFaviconPng(browser, { colorScheme: 'dark' }), 'image/png'))
    const luminance = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
    assert.ok(luminance(light) < 64, `light-scheme stroke is dark ink, got rgb(${light})`)
    assert.ok(luminance(dark) > 192, `dark-scheme stroke is light, got rgb(${dark})`)
  } finally {
    await browser.close()
  }
})

test('/favicon.ico still draws what web/favicon.svg draws, so the two cannot drift apart (#364)', async () => {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    const committed = await pixelsOf(page, readFileSync(FAVICON_ICO), 'image/x-icon')
    const fresh = await pixelsOf(page, await renderFaviconPng(browser, { tile: ICO_TILE }), 'image/png')
    assert.equal(committed.width, ICO_SIZE)
    assert.equal(committed.height, ICO_SIZE)
    // A small per-channel allowance, so a newer Chromium's anti-aliasing alone doesn't fail this; a
    // changed path, stroke or colour moves whole pixels by far more. Re-run
    // scripts/render-favicon-ico.mjs after changing the SVG.
    let worst = 0
    for (let i = 0; i < fresh.data.length; i++) worst = Math.max(worst, Math.abs(fresh.data[i] - committed.data[i]))
    assert.ok(worst <= 48, `web/favicon.ico differs from web/favicon.svg by up to ${worst} per channel`)
  } finally {
    await browser.close()
  }
})

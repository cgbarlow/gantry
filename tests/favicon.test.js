import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withRunningServer } from './helpers/lifecycle.js'

// #364: Gantry's favicon is the gantry mark from the app header — the arch `GantryBrandIcon` draws —
// so a Gantry tab, bookmark or history entry carries the same mark the page itself opens with.

// The product owner's decision on #364: this exact line path, on the header's 24×24 grid.
const GANTRY_MARK_PATH = 'M3 20h18M6 20V8l6-4 6 4v12M6 8h12'

const ICON_LINK = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />'

// The `d` of the one <path> inside a source's `function GantryBrandIcon() { … }`.
function brandIconPath(file) {
  const source = readFileSync(file, 'utf8')
  const body = source.match(/function GantryBrandIcon\(\) \{([\s\S]*?)\n\}/)?.[1]
  assert.ok(body, `${file} defines GantryBrandIcon`)
  return body.match(/<path d="([^"]+)"/)?.[1]
}

function htmlFilesUnder(dir) {
  return readdirSync(dir, { recursive: true })
    .filter((name) => name.endsWith('.html'))
    .map((name) => join(dir, name))
}

test('the favicon and both inline header marks draw one and the same path, so they cannot drift apart (#364)', () => {
  assert.equal(brandIconPath('web/app.js'), GANTRY_MARK_PATH)
  assert.equal(brandIconPath('web/pages/user-guide.js'), GANTRY_MARK_PATH)
  const svg = readFileSync('web/favicon.svg', 'utf8')
  assert.deepEqual([...svg.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]), [GANTRY_MARK_PATH])
  // The header's own grid, so the shape is the header's and only the stroke is tuned for a tab.
  assert.match(svg, /viewBox="0 0 24 24"/)
})

test('the favicon names its stroke colour outright, and turns it light on a dark browser (#364)', () => {
  const svg = readFileSync('web/favicon.svg', 'utf8')
  // `currentColor` means nothing in a browser tab: there is no surrounding text to take it from.
  assert.doesNotMatch(svg, /currentColor/)
  const light = svg.match(/path\s*\{\s*stroke:\s*(#[0-9A-Fa-f]{6})/)?.[1]
  const dark = svg.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{\s*path\s*\{\s*stroke:\s*(#[0-9A-Fa-f]{6})/)?.[1]
  assert.ok(light, 'a default stroke colour')
  assert.ok(dark, 'a dark-scheme stroke colour')
  assert.notEqual(light.toLowerCase(), dark.toLowerCase())
})

test('every HTML page under web/ links the favicon (#364)', () => {
  const pages = htmlFilesUnder('web')
  assert.ok(pages.includes(join('web', 'index.html')))
  for (const page of pages) {
    assert.ok(readFileSync(page, 'utf8').includes(ICON_LINK), `${page} links /favicon.svg`)
  }
})

test('GET /favicon.svg serves the mark as image/svg+xml, revalidating like every other static file (#364)', async () => {
  await withRunningServer({}, async (base) => {
    const res = await fetch(`${base}/favicon.svg`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/svg+xml')
    assert.equal(res.headers.get('cache-control'), 'no-cache')
    assert.ok(res.headers.get('etag'))
    assert.ok((await res.text()).includes(`d="${GANTRY_MARK_PATH}"`))
  })
})

test('GET /favicon.ico serves a real icon — an ICO holding one 32×32 PNG — not a 404 (#364)', async () => {
  await withRunningServer({}, async (base) => {
    const res = await fetch(`${base}/favicon.ico`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/x-icon')
    const ico = Buffer.from(await res.arrayBuffer())
    // ICONDIR: reserved 0, type 1 (icon), one image.
    assert.equal(ico.readUInt16LE(0), 0)
    assert.equal(ico.readUInt16LE(2), 1)
    assert.equal(ico.readUInt16LE(4), 1)
    // ICONDIRENTRY: 32×32, its bytes running to the end of the file.
    assert.equal(ico[6], 32)
    assert.equal(ico[7], 32)
    const size = ico.readUInt32LE(14)
    const offset = ico.readUInt32LE(18)
    assert.equal(offset + size, ico.length)
    const png = ico.subarray(offset)
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // IHDR's width and height.
    assert.equal(png.readUInt32BE(16), 32)
    assert.equal(png.readUInt32BE(20), 32)
  })
})

test('the app shell links the favicon, on / and on a client-side route alike (#364)', async () => {
  await withRunningServer({}, async (base) => {
    for (const path of ['/', '/user-guide', '/instance/anything']) {
      const html = await (await fetch(`${base}${path}`)).text()
      assert.ok(html.includes(ICON_LINK), `${path} links /favicon.svg`)
    }
  })
})

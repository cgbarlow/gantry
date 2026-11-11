#!/usr/bin/env node
// #364: draws web/favicon.ico from web/favicon.svg, for the browsers and tools (bookmark managers,
// link previews) that ask for /favicon.ico rather than reading the page's <link rel="icon">.
//
// The .ico is committed rather than built on the fly, so Gantry needs no image library at runtime or
// at install. Chromium (Playwright, which the test suite already installs) draws the SVG at 32×32,
// and the PNG it produces goes into an ICO container as is — Windows Vista on, and every browser,
// reads a PNG-in-ICO. Unlike the SVG, a PNG cannot follow the browser's colour scheme, and dark ink
// alone all but vanishes on a dark tab. So the .ico draws the mark as the app's light theme shows it
// in the header: the light scheme's ink on a small rounded tile of the light theme's paper
// (web/style.css's --bg), which reads on a light tab and a dark one alike.
//
// Run it after changing web/favicon.svg:  node scripts/render-favicon-ico.mjs
// tests/favicon.playwright.test.js fails if the committed .ico no longer matches the SVG.
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { launchBrowser } from '../tests/helpers/launchBrowser.js'

export const FAVICON_SVG = 'web/favicon.svg'
export const FAVICON_ICO = 'web/favicon.ico'
export const ICO_SIZE = 32
export const ICO_TILE = '#EDEBE6'

// The SVG at `size`×`size` as Chromium draws it in `colorScheme`: on a rounded `tile` of that colour,
// or transparent around the mark when `tile` is null.
export async function renderFaviconPng(browser, { colorScheme = 'light', size = ICO_SIZE, tile = null } = {}) {
  const context = await browser.newContext({ colorScheme, deviceScaleFactor: 1 })
  try {
    const page = await context.newPage()
    const svg = readFileSync(FAVICON_SVG).toString('base64')
    await page.setContent(
      `<style>html, body { margin: 0; background: transparent; } #icon { display: block; border-radius: 3px; ` +
        `background: ${tile ?? 'transparent'}; }</style>` +
        `<img id="icon" width="${size}" height="${size}" src="data:image/svg+xml;base64,${svg}">`
    )
    await page.locator('#icon').evaluate((img) => img.decode())
    return await page.locator('#icon').screenshot({ omitBackground: true })
  } finally {
    await context.close()
  }
}

// One PNG, wrapped in the 22 bytes an ICO file needs to hold it: the ICONDIR header (reserved, type 1
// for an icon, one image) and a single ICONDIRENTRY pointing at the PNG right after it.
export function icoFromPng(png, size = ICO_SIZE) {
  const header = Buffer.alloc(6 + 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header.writeUInt8(size % 256, 6) // width (0 would mean 256)
  header.writeUInt8(size % 256, 7) // height
  header.writeUInt8(0, 8) // no palette
  header.writeUInt8(0, 9) // reserved
  header.writeUInt16LE(1, 10) // colour planes
  header.writeUInt16LE(32, 12) // bits per pixel
  header.writeUInt32LE(png.length, 14)
  header.writeUInt32LE(header.length, 18)
  return Buffer.concat([header, png])
}

async function main() {
  const browser = await launchBrowser()
  try {
    writeFileSync(FAVICON_ICO, icoFromPng(await renderFaviconPng(browser, { tile: ICO_TILE })))
    console.log(`Wrote ${FAVICON_ICO}`)
  } finally {
    await browser.close()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()

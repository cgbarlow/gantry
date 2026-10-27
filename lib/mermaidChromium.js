import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildImportMap } from './importmap.js'
import { replaceMermaidBlocks } from '../web/lib/mermaid.js'

// #198 (spec #192, docs/adr/0055-cli-draws-mermaid-in-optional-headless-chromium.md) — phase 2
// of docs/adr/0030: `gantry render` draws Mermaid diagrams the way the browser export does.
//
// Mermaid can only lay a diagram out inside a real browser engine (it measures text through the
// page), so this does not reimplement any of it. It opens Playwright's headless Chromium on a
// blank page, serves that page the browser's own `web/lib/mermaid.js` and its dependencies, and
// calls the same `prepareMermaidForDocx` the browser's WASM export calls. The CLI therefore gets
// the same Mermaid configuration, the same 2x PNG, the same `mermaid-diagram-N.png` names and the
// same "Diagram N. <title>" image references, and none of that can drift between the two paths.
//
// Chromium is optional and CLI-only. `playwright` is an optionalDependency, its browser is a
// separate `npx playwright install chromium`, and the server and its container image install
// neither. When either is missing, this reports why in one warning and the render carries on
// with each diagram left as its source, as `gantry render` always did.

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const WEB_DIR = join(PKG_ROOT, 'web')
const NODE_MODULES_DIR = join(PKG_ROOT, 'node_modules')

// The page's own origin. Nothing is ever fetched from it: every request the page makes is
// answered from the files above by `servePageRequest`, and anything else is aborted, so the page
// has no network access at all. `.invalid` is reserved (RFC 2606) and can never resolve.
const PAGE_ORIGIN = 'http://gantry-mermaid.invalid'

// web/lib/mermaid.js's one bare import. Its other imports are relative, or the mermaid bundle by
// its fixed `/node_modules/` path.
const PAGE_SPECIFIERS = ['dompurify']

const SOURCE_KEPT = 'Warning: Mermaid diagrams were left as source text in the Word document.'
const PACKAGE_MISSING =
  `${SOURCE_KEPT} Drawing them needs the optional headless Chromium: run \`npm install --include=optional\` ` +
  'in the Gantry directory, then `npx playwright install chromium`.'
const BROWSER_MISSING = `${SOURCE_KEPT} Drawing them needs the optional headless Chromium: run \`npx playwright install chromium\`.`

const CONTENT_TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json' }

function servePageRequest(route, importMap) {
  const { pathname } = new URL(route.request().url())
  if (pathname === '/') {
    return route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta charset="utf-8"><script type="importmap">${JSON.stringify(importMap)}</script>`,
    })
  }
  const [root, relative] = pathname.startsWith('/node_modules/')
    ? [NODE_MODULES_DIR, pathname.slice('/node_modules/'.length)]
    : [WEB_DIR, pathname.slice(1)]
  const file = normalize(join(root, decodeURIComponent(relative)))
  if (!file.startsWith(normalize(root) + sep) || !existsSync(file) || !statSync(file).isFile()) {
    return route.fulfill({ status: 404, body: 'Not found' })
  }
  return route.fulfill({ contentType: CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', body: readFileSync(file) })
}

// Runs in the page: the browser export's own preparation, with each PNG handed back as base64.
async function prepareInPage(markdown) {
  const { prepareMermaidForDocx } = await import('/lib/mermaid.js')
  const prepared = await prepareMermaidForDocx(markdown)
  const files = {}
  for (const [name, blob] of Object.entries(prepared.files)) {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    files[name] = btoa(binary)
  }
  return { markdown: prepared.markdown, files }
}

function firstLine(err) {
  return String(err?.message ?? err).split('\n')[0].trim()
}

/**
 * Draws the Mermaid blocks of Word-bound artefact markdown (the compile step's `docxMarkdown`) in
 * headless Chromium, exactly as the browser export does. Never throws: when Chromium is missing or
 * fails, the markdown comes back unchanged, with one warning saying why.
 *
 * @param {string} markdown
 * @returns {Promise<{ markdown: string, files: Record<string, Buffer>, warning: string|null }>}
 *   `markdown` with each drawn block replaced by an image reference, `files` the PNGs those
 *   references name, and `warning` set when the diagrams were left as source. A block Mermaid
 *   can't parse stays as source with no warning, as it does in the browser export.
 */
export async function drawMermaidInChromium(markdown) {
  const unchanged = (warning) => ({ markdown, files: {}, warning })
  if (replaceMermaidBlocks(markdown, (block) => block.code).blocks.length === 0) return unchanged(null)

  let chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    return unchanged(PACKAGE_MISSING)
  }

  let browser
  try {
    browser = await chromium.launch()
  } catch (err) {
    if (/Executable doesn't exist/.test(err?.message ?? '')) return unchanged(BROWSER_MISSING)
    return unchanged(`${SOURCE_KEPT} Headless Chromium could not start: ${firstLine(err)}`)
  }

  try {
    const page = await browser.newPage()
    const importMap = buildImportMap(PAGE_SPECIFIERS, { nodeModulesDir: NODE_MODULES_DIR })
    // Routes registered later take precedence: the page's own origin is served, all else aborted.
    await page.route('**/*', (route) => route.abort())
    await page.route(`${PAGE_ORIGIN}/**`, (route) => servePageRequest(route, importMap))
    await page.goto(`${PAGE_ORIGIN}/`)
    const prepared = await page.evaluate(prepareInPage, markdown)
    const files = Object.fromEntries(Object.entries(prepared.files).map(([name, base64]) => [name, Buffer.from(base64, 'base64')]))
    return { markdown: prepared.markdown, files, warning: null }
  } catch (err) {
    return unchanged(`${SOURCE_KEPT} Headless Chromium could not draw them: ${firstLine(err)}`)
  } finally {
    await browser.close().catch(() => {})
  }
}

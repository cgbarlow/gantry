import DOMPurify from 'dompurify'

// WI #353 — Mermaid diagrams in the editor preview and in browser-driven `.docx` exports.
// Resolves the deferral recorded in docs/adr/0020-full-soap-artefact.md; see
// docs/adr/0030-mermaid-rendering-in-the-browser.md for the trade-offs.
//
// Same shape as web/lib/pandocWasm.js: mermaid is vendored under node_modules and served by
// lib/server.js's `/node_modules/` static route, and this module imports its *self-contained*
// ESM bundle (`dist/mermaid.esm.min.mjs`, which pulls its own `./chunks/…` by relative path)
// via a fixed URL rather than the bare `mermaid` specifier. The bare specifier resolves
// through lib/importmap.js to `dist/mermaid.core.mjs`, which bare-imports ~20 further
// packages (d3, dagre, …) — several of which need a bundler's `browser` field handling that
// `resolveEntry` deliberately doesn't do (docs/adr/0006). The bundle needs none of that.
//
// Lazy on purpose: the bundle is ~3MB. Nothing is fetched until the first Mermaid block
// actually needs rendering — a preview with no diagrams never pays for it.
const MERMAID_BUNDLE_URL = '/node_modules/mermaid/dist/mermaid.esm.min.mjs'

// Pixel ratio for the PNG that goes into a .docx. 2x keeps text crisp when Word scales the
// image to page width; SVG itself was rejected for the export (Word's SVG support is uneven
// across builds) — see the ADR.
const DOCX_PNG_SCALE = 2

// Filename prefix for the generated images inside pandoc-wasm's virtual filesystem. Only the
// docx conversion ever sees these names; the exported `.md` keeps the fenced source.
const DOCX_IMAGE_PREFIX = 'mermaid-diagram-'

let mermaidPromise = null
let renderCounter = 0

// Test-only — same rationale as pandocWasm.js's `resetForTests`.
export function resetForTests() {
  mermaidPromise = null
  renderCounter = 0
}

async function loadMermaid({ importBundle = () => import(MERMAID_BUNDLE_URL) } = {}) {
  if (!mermaidPromise) {
    mermaidPromise = importBundle()
      .then((mod) => {
        const mermaid = mod.default ?? mod
        // `strict` is mermaid's default; stated explicitly because the output is injected into
        // the preview DOM. The SVG is additionally passed through DOMPurify below.
        // `htmlLabels: false` everywhere: mermaid's default wraps labels in `<foreignObject>`
        // HTML, which (a) taints a canvas when drawn into it, so `canvas.toBlob` throws and the
        // docx PNG can never be produced, and (b) is exactly the SVG subset DOMPurify strips.
        // Plain SVG `<text>` labels avoid both, at the cost of no HTML markup inside labels.
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'neutral',
          htmlLabels: false,
          flowchart: { htmlLabels: false },
          sequence: { htmlLabels: false },
          class: { htmlLabels: false },
          state: { htmlLabels: false },
          er: { htmlLabels: false },
          gantt: { htmlLabels: false },
        })
        return mermaid
      })
      .catch((err) => {
        mermaidPromise = null
        throw err
      })
  }
  return mermaidPromise
}

/**
 * Renders one Mermaid definition to sanitised SVG markup. Rejects on a syntax error — callers
 * decide how to surface that (the preview shows the source with the error; the docx path
 * leaves the block as a code block).
 *
 * @param {string} code the Mermaid source, without the fence
 * @param {{ importBundle?: Function }} [testOverrides]
 * @returns {Promise<string>} sanitised `<svg>…</svg>` markup
 */
export async function renderMermaidSvg(code, testOverrides) {
  const mermaid = await loadMermaid(testOverrides)
  renderCounter += 1
  // Mermaid needs a DOM id that is unique per render on the page; the element is removed by
  // mermaid itself once the SVG string is produced.
  const { svg } = await mermaid.render(`gantry-mermaid-${renderCounter}`, code)
  return sanitiseSvg(svg)
}

// DOMPurify's default export is only a ready sanitiser when a `window` exists; under
// `node --test` (tests/mermaid.test.js) it is the bare factory, and there is no DOM to
// inject into anyway, so the markup passes through untouched there.
function sanitiseSvg(svg) {
  if (typeof DOMPurify.sanitize !== 'function') return svg
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })
}

/**
 * The fenced-block scanner shared by the preview and the docx path. Pure: no DOM, no mermaid —
 * testable under `node --test`. Recognises ```mermaid / ~~~mermaid fences (any indent up to
 * three spaces, any info-string suffix after the word) and returns the source with each block
 * replaced by whatever `replace` returns, plus the list of blocks in document order.
 *
 * Fences inside a longer fence of a different language (```md containing ```mermaid) are not
 * special-cased: markdown-it would treat that the same way, and no artefact template does it.
 *
 * @param {string} markdown
 * @param {(block: { code: string, index: number }) => string} replace
 * @returns {{ markdown: string, blocks: Array<{ code: string, index: number }> }}
 */
export function replaceMermaidBlocks(markdown, replace) {
  const blocks = []
  const re = /^( {0,3})(`{3,}|~{3,})[ \t]*mermaid\b[^\n]*\n([\s\S]*?)\n\1\2[ \t]*$/gm
  const out = (markdown ?? '').replace(re, (match, _indent, _fence, code) => {
    const block = { code: code.replace(/^\n+|\n+$/g, ''), index: blocks.length }
    blocks.push(block)
    return replace(block)
  })
  return { markdown: out, blocks }
}

/**
 * Rasterises sanitised SVG markup to PNG bytes with an off-screen canvas. Browser-only.
 *
 * @param {string} svg
 * @param {number} [scale]
 * @returns {Promise<Uint8Array>}
 */
export async function svgToPngBytes(svg, scale = DOCX_PNG_SCALE) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = doc.documentElement
  // Mermaid emits `width="100%"` plus a viewBox; the canvas needs real pixel dimensions.
  const viewBox = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number)
  const width = Math.ceil(viewBox.length === 4 && viewBox[2] > 0 ? viewBox[2] : Number.parseFloat(root.getAttribute('width')) || 800)
  const height = Math.ceil(viewBox.length === 4 && viewBox[3] > 0 ? viewBox[3] : Number.parseFloat(root.getAttribute('height')) || 400)
  root.setAttribute('width', String(width))
  root.setAttribute('height', String(height))
  const serialised = new XMLSerializer().serializeToString(root)
  const blob = new Blob([serialised], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  try {
    const image = await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('Could not rasterise the Mermaid SVG'))
      img.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = width * scale
    canvas.height = height * scale
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
    const pngBlob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('canvas.toBlob failed'))), 'image/png'))
    return new Uint8Array(await pngBlob.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Prepares compiled artefact markdown for a browser-side docx conversion: every Mermaid block
 * becomes an image reference and its PNG bytes land in `files` for pandoc-wasm's virtual
 * filesystem (web/lib/pandocWasm.js `renderDocxWithWasm({ files })`). A block that fails to
 * render stays as its fenced source so one bad diagram never blocks the export.
 *
 * @param {string} markdown the compiled artefact markdown (the `.md` that is written out
 *   unchanged — this function's result is for the docx conversion only)
 * @param {{ importBundle?: Function }} [testOverrides]
 * @returns {Promise<{ markdown: string, files: Record<string, Blob> }>}
 */
export async function prepareMermaidForDocx(markdown, testOverrides) {
  const { blocks } = replaceMermaidBlocks(markdown, (block) => ` mermaid:${block.index} `)
  if (blocks.length === 0) return { markdown, files: {} }

  const files = {}
  const rendered = new Map()
  for (const block of blocks) {
    try {
      const svg = await renderMermaidSvg(block.code, testOverrides)
      const png = await svgToPngBytes(svg)
      const name = `${DOCX_IMAGE_PREFIX}${block.index + 1}.png`
      files[name] = new Blob([png], { type: 'image/png' })
      rendered.set(block.index, name)
    } catch {
      // Left as source below.
    }
  }

  const { markdown: out } = replaceMermaidBlocks(markdown, (block) => {
    const name = rendered.get(block.index)
    if (!name) return '```mermaid\n' + block.code + '\n```'
    return `![Diagram ${block.index + 1}](${name})`
  })
  return { markdown: out, files }
}

/**
 * Preview hook: after markdown-it has rendered a field into `node`, swap each
 * `<pre><code class="language-mermaid">` for the rendered diagram. Async and fire-and-forget:
 * if the preview re-renders before a diagram finishes, the stale `<pre>` is simply gone from
 * the DOM and the swap is a no-op. A block that fails to parse keeps its source and gains an
 * error line, so the author sees what Mermaid objected to.
 *
 * @param {HTMLElement} node
 * @param {{ importBundle?: Function }} [testOverrides]
 */
export async function hydrateMermaidPreview(node, testOverrides) {
  if (!node) return
  const codes = Array.from(node.querySelectorAll('pre > code.language-mermaid'))
  for (const code of codes) {
    const pre = code.parentElement
    const source = code.textContent ?? ''
    try {
      const svg = await renderMermaidSvg(source, testOverrides)
      if (!pre.isConnected) continue
      const figure = document.createElement('figure')
      figure.className = 'mermaid-diagram'
      figure.innerHTML = svg
      pre.replaceWith(figure)
    } catch (err) {
      if (!pre.isConnected) continue
      pre.classList.add('mermaid-error')
      const note = document.createElement('div')
      note.className = 'mermaid-error-note'
      note.textContent = `Mermaid: ${err?.message ?? 'could not render this diagram'}`
      pre.after(note)
    }
  }
}

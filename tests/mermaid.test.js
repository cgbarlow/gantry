import { test } from 'node:test'
import assert from 'node:assert/strict'
import { replaceMermaidBlocks, renderMermaidSvg, resetForTests } from '../web/lib/mermaid.js'

// WI #353 — the DOM-free half of web/lib/mermaid.js. The fenced-block scanner is what both
// the preview and the docx export rely on to find diagrams, so it gets exhaustive unit
// coverage here; the actual mermaid render, SVG→PNG rasterisation and pandoc-wasm embedding
// need a real browser and are covered by tests/mermaidRender.playwright.test.js.

test('replaceMermaidBlocks finds a ```mermaid fence and hands the caller its source', () => {
  const md = 'Intro\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nOutro\n'
  const { markdown, blocks } = replaceMermaidBlocks(md, (b) => `[[${b.index}]]`)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].code, 'flowchart LR\n  A --> B')
  assert.equal(markdown, 'Intro\n\n[[0]]\n\nOutro\n')
})

test('replaceMermaidBlocks numbers several blocks in document order and leaves other fences alone', () => {
  const md = ['```js', 'x()', '```', '', '```mermaid', 'graph TD', 'A-->B', '```', '', '~~~mermaid', 'sequenceDiagram', 'A->>B: hi', '~~~', ''].join('\n')
  const { markdown, blocks } = replaceMermaidBlocks(md, (b) => `<${b.index}>`)
  assert.deepEqual(
    blocks.map((b) => b.code),
    ['graph TD\nA-->B', 'sequenceDiagram\nA->>B: hi']
  )
  assert.ok(markdown.includes('```js\nx()\n```'), 'a non-mermaid fence must survive untouched')
  assert.ok(markdown.includes('<0>') && markdown.includes('<1>'))
})

test('replaceMermaidBlocks tolerates an info-string suffix, indentation up to three spaces, and longer fences', () => {
  const md = '   ````mermaid {title="x"}\n   pie\n   "a": 1\n   ````\n'
  const { blocks } = replaceMermaidBlocks(md, () => 'X')
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].code, '   pie\n   "a": 1')
})

test('replaceMermaidBlocks ignores an unterminated fence and handles empty/null input', () => {
  assert.deepEqual(replaceMermaidBlocks('```mermaid\ngraph TD\n', () => 'X'), { markdown: '```mermaid\ngraph TD\n', blocks: [] })
  assert.deepEqual(replaceMermaidBlocks('', () => 'X'), { markdown: '', blocks: [] })
  assert.deepEqual(replaceMermaidBlocks(null, () => 'X'), { markdown: '', blocks: [] })
})

test('renderMermaidSvg loads the bundle once, initialises it, and returns the rendered svg', async () => {
  resetForTests()
  let imports = 0
  let initialised = null
  const importBundle = async () => {
    imports += 1
    return {
      default: {
        initialize: (cfg) => {
          initialised = cfg
        },
        render: async (id, code) => ({ svg: `<svg data-id="${id}"><text>${code}</text></svg>` }),
      },
    }
  }
  // DOMPurify needs a window; under node --test there is none, so a minimal shim is enough to
  // confirm the module wires the bundle correctly — sanitisation itself is exercised in the
  // Playwright suite. Without a window DOMPurify.sanitize returns its input unchanged.
  const first = await renderMermaidSvg('graph TD', { importBundle })
  const second = await renderMermaidSvg('graph LR', { importBundle })
  assert.equal(imports, 1, 'the bundle is imported once and cached')
  assert.equal(initialised?.securityLevel, 'strict')
  assert.equal(initialised?.startOnLoad, false)
  assert.match(first, /graph TD/)
  assert.match(second, /graph LR/)
  assert.notEqual(first.match(/data-id="([^"]+)"/)?.[1], second.match(/data-id="([^"]+)"/)?.[1], 'each render gets a unique id')
})

test('renderMermaidSvg clears the cached load after a failed import so a retry can succeed', async () => {
  resetForTests()
  let attempts = 0
  const importBundle = async () => {
    attempts += 1
    if (attempts === 1) throw new Error('network down')
    return { default: { initialize() {}, render: async () => ({ svg: '<svg/>' }) } }
  }
  await assert.rejects(renderMermaidSvg('graph TD', { importBundle }), /network down/)
  const svg = await renderMermaidSvg('graph TD', { importBundle })
  assert.equal(svg, '<svg/>')
  assert.equal(attempts, 2)
})

// ---- Browser-only functions, driven under node --test with minimal DOM shims ----
// svgToPngBytes / prepareMermaidForDocx / hydrateMermaidPreview are exercised for real in
// tests/mermaidRender.playwright.test.js; these shims cover the control flow (sizing from the
// viewBox, the file/markdown rewrite contract, the swap-or-annotate branches) so the module's
// unit coverage reflects all of it, not just the scanner.

function installDomShims({ toBlobFails = false, imageFails = false } = {}) {
  const saved = {}
  const g = globalThis
  for (const k of ['DOMParser', 'XMLSerializer', 'Image', 'document', 'URL']) saved[k] = g[k]

  const makeSvgRoot = (attrs) => ({
    attrs: { ...attrs },
    getAttribute(n) {
      return this.attrs[n] ?? null
    },
    setAttribute(n, v) {
      this.attrs[n] = v
    },
  })
  g.DOMParser = class {
    parseFromString(svg) {
      const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1]
      const width = svg.match(/ width="([^"]+)"/)?.[1]
      const height = svg.match(/ height="([^"]+)"/)?.[1]
      const attrs = {}
      if (viewBox) attrs.viewBox = viewBox
      if (width) attrs.width = width
      if (height) attrs.height = height
      return { documentElement: makeSvgRoot(attrs) }
    }
  }
  g.XMLSerializer = class {
    serializeToString(root) {
      return `<svg width="${root.attrs.width}" height="${root.attrs.height}"/>`
    }
  }
  g.Image = class {
    set src(_v) {
      queueMicrotask(() => (imageFails ? this.onerror?.() : this.onload?.()))
    }
  }
  const realURL = saved.URL
  g.URL = Object.assign(function URLShim(...a) {
    return new realURL(...a)
  }, realURL, { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} })
  const drawn = []
  g.document = {
    createElement(tag) {
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({ fillRect() {}, drawImage: (...a) => drawn.push(a) }),
          toBlob(cb) {
            cb(toBlobFails ? null : new Blob([new Uint8Array([137, 80, 78, 71])]))
          },
        }
      }
      // figure / div for hydrateMermaidPreview
      return {
        tagName: tag,
        className: '',
        innerHTML: '',
        textContent: '',
      }
    },
  }
  return {
    drawn,
    restore() {
      for (const k of Object.keys(saved)) g[k] = saved[k]
    },
  }
}

test('svgToPngBytes sizes the canvas from the viewBox at the requested scale and returns PNG bytes', async () => {
  const shims = installDomShims()
  try {
    const { svgToPngBytes } = await import('../web/lib/mermaid.js')
    const bytes = await svgToPngBytes('<svg viewBox="0 0 300.4 120" width="100%"/>', 2)
    assert.ok(bytes instanceof Uint8Array)
    assert.deepEqual([...bytes], [137, 80, 78, 71])
    assert.deepEqual(shims.drawn[0].slice(1), [0, 0, 602, 240], 'ceil(300.4)*2 by 120*2')
  } finally {
    shims.restore()
  }
})

test('svgToPngBytes falls back to width/height attributes, then to defaults, when there is no viewBox', async () => {
  const shims = installDomShims()
  try {
    const { svgToPngBytes } = await import('../web/lib/mermaid.js')
    await svgToPngBytes('<svg width="50" height="25"/>', 1)
    assert.deepEqual(shims.drawn[0].slice(1), [0, 0, 50, 25])
    await svgToPngBytes('<svg/>', 1)
    assert.deepEqual(shims.drawn[1].slice(1), [0, 0, 800, 400])
  } finally {
    shims.restore()
  }
})

test('svgToPngBytes rejects when the image cannot load or the canvas produces no blob', async () => {
  let shims = installDomShims({ imageFails: true })
  try {
    const { svgToPngBytes } = await import('../web/lib/mermaid.js')
    await assert.rejects(svgToPngBytes('<svg viewBox="0 0 1 1"/>'), /rasterise/)
  } finally {
    shims.restore()
  }
  shims = installDomShims({ toBlobFails: true })
  try {
    const { svgToPngBytes } = await import('../web/lib/mermaid.js')
    await assert.rejects(svgToPngBytes('<svg viewBox="0 0 1 1"/>'), /toBlob/)
  } finally {
    shims.restore()
  }
})

const fakeBundle = (renderImpl) => async () => ({ default: { initialize() {}, render: renderImpl } })

test('prepareMermaidForDocx rewrites each block to an image reference and returns the PNG for it, leaving markdown without diagrams untouched', async () => {
  const shims = installDomShims()
  try {
    resetForTests()
    const { prepareMermaidForDocx } = await import('../web/lib/mermaid.js')
    const plain = await prepareMermaidForDocx('no diagrams here\n')
    assert.deepEqual(plain, { markdown: 'no diagrams here\n', files: {} })

    const md = 'A\n\n```mermaid\ngraph TD\n```\n\nB\n\n```mermaid\npie\n```\n'
    const importBundle = fakeBundle(async () => ({ svg: '<svg viewBox="0 0 10 10"/>' }))
    const out = await prepareMermaidForDocx(md, { importBundle })
    assert.equal(out.markdown, 'A\n\n![Diagram 1](mermaid-diagram-1.png)\n\nB\n\n![Diagram 2](mermaid-diagram-2.png)\n')
    assert.deepEqual(Object.keys(out.files), ['mermaid-diagram-1.png', 'mermaid-diagram-2.png'])
    assert.ok(out.files['mermaid-diagram-1.png'] instanceof Blob)
  } finally {
    shims.restore()
  }
})

test('prepareMermaidForDocx keeps a block that fails to render as its fenced source, and still converts the others', async () => {
  const shims = installDomShims()
  try {
    resetForTests()
    const { prepareMermaidForDocx } = await import('../web/lib/mermaid.js')
    const importBundle = fakeBundle(async (_id, code) => {
      if (code.includes('bad')) throw new Error('parse error')
      return { svg: '<svg viewBox="0 0 10 10"/>' }
    })
    const md = '```mermaid\nbad\n```\n\n```mermaid\ngraph TD\n```\n'
    const out = await prepareMermaidForDocx(md, { importBundle })
    assert.equal(out.markdown, '```mermaid\nbad\n```\n\n![Diagram 2](mermaid-diagram-2.png)\n')
    assert.deepEqual(Object.keys(out.files), ['mermaid-diagram-2.png'])
  } finally {
    shims.restore()
  }
})

function fakePreviewNode(sources) {
  const pres = sources.map((source) => {
    const pre = { isConnected: true, classes: new Set(), after: null, replacedWith: null }
    pre.classList = { add: (c) => pre.classes.add(c) }
    pre.replaceWith = (el) => {
      pre.replacedWith = el
      pre.isConnected = false
    }
    pre.after = (el) => {
      pre.afterEl = el
    }
    pre.code = { textContent: source, parentElement: pre }
    return pre
  })
  return {
    pres,
    querySelectorAll: (sel) => (sel === 'pre > code.language-mermaid' ? pres.map((p) => p.code) : []),
  }
}

test('hydrateMermaidPreview swaps a rendered block for a figure and annotates a failed one, and is a no-op for a missing node', async () => {
  const shims = installDomShims()
  try {
    resetForTests()
    const { hydrateMermaidPreview } = await import('../web/lib/mermaid.js')
    await hydrateMermaidPreview(null)
    const importBundle = fakeBundle(async (_id, code) => {
      if (code === 'bad') throw new Error('unexpected token')
      return { svg: `<svg>${code}</svg>` }
    })
    const node = fakePreviewNode(['graph TD', 'bad'])
    await hydrateMermaidPreview(node, { importBundle })
    const [good, bad] = node.pres
    assert.equal(good.replacedWith.className, 'mermaid-diagram')
    assert.equal(good.replacedWith.innerHTML, '<svg>graph TD</svg>')
    assert.equal(bad.replacedWith, null)
    assert.ok(bad.classes.has('mermaid-error'))
    assert.equal(bad.afterEl.className, 'mermaid-error-note')
    assert.equal(bad.afterEl.textContent, 'Mermaid: unexpected token')
  } finally {
    shims.restore()
  }
})

test('hydrateMermaidPreview leaves a block alone when the preview re-rendered before the diagram finished', async () => {
  const shims = installDomShims()
  try {
    resetForTests()
    const { hydrateMermaidPreview } = await import('../web/lib/mermaid.js')
    const node = fakePreviewNode(['graph TD', 'bad'])
    const importBundle = fakeBundle(async (_id, code) => {
      // Simulate a re-render happening mid-flight: every <pre> is detached.
      for (const p of node.pres) p.isConnected = false
      if (code === 'bad') throw new Error('x')
      return { svg: '<svg/>' }
    })
    await hydrateMermaidPreview(node, { importBundle })
    assert.equal(node.pres[0].replacedWith, null)
    assert.equal(node.pres[1].afterEl, undefined)
  } finally {
    shims.restore()
  }
})

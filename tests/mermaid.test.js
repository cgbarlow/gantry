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

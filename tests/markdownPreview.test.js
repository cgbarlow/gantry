import { test } from 'node:test'
import assert from 'node:assert/strict'

// #347: the module editor's preview of Markdown (web/lib/markdownPreview.js), moved out of the app shell so the AI interview's thread can
// draw the AI's replies through it too. Under node --test there is no DOM: this pins the parts that need none (taking a citation apart,
// the index a panel's list makes, what opening a citation does) and the order of the steps, on a stand-in node. What a real page draws,
// citations and diagrams included, is in tests/source-citations.playwright.test.js, tests/mermaidRender.playwright.test.js and
// tests/interviewMarkdown.playwright.test.js.
import DOMPurify from 'dompurify'

// DOMPurify needs a window and under node --test there is none, so here it passes markdown-it's HTML through; what it removes is pinned in
// the Playwright tests, in a real browser.
DOMPurify.sanitize ??= (html) => html
const { citedRef, citationIndex, openCitation, renderMarkdownPreview } = await import('../web/lib/markdownPreview.js')

test('a citation is taken apart into its id and, for a repository, the file and the commit it names', () => {
  assert.deepEqual(citedRef('client-brief'), { id: 'client-brief' })
  assert.deepEqual(citedRef('billing-api?path=src/orders.ts&commit=3f2a9c1'), { id: 'billing-api', path: 'src/orders.ts', commit: '3f2a9c1' })
})

test('the index a Source documents list makes: each document by id, with its title and file, a removed one marked, a repository kept', () => {
  const repository = { provider: 'github', location: { owner: 'acme', repository: 'billing' }, branch: 'main' }
  const index = citationIndex([
    { id: 'client-brief', title: 'Client brief', filename: 'Client brief.pdf', size: 10 },
    { id: 'old-notes', title: 'Old notes', filename: 'notes.txt', removedAt: '2026-11-01T00:00:00Z' },
    { id: 'billing-api', title: 'Billing API', repository },
  ])
  assert.deepEqual(index, {
    'client-brief': { title: 'Client brief', filename: 'Client brief.pdf', removed: false },
    'old-notes': { title: 'Old notes', filename: 'notes.txt', removed: true },
    'billing-api': { title: 'Billing API', filename: undefined, removed: false, repository },
  })
  assert.deepEqual(citationIndex(null), {})
})

test('opening a citation: a removed or unknown document opens nothing, a document is read from the store, a repository opens on its Provider', async () => {
  const reads = []
  const store = { readOriginal: async (id) => (reads.push(id), { bytes: null }) }
  const index = citationIndex([
    { id: 'client-brief', title: 'Client brief', filename: 'Client brief.pdf' },
    { id: 'old-notes', title: 'Old notes', filename: 'notes.txt', removedAt: '2026-11-01T00:00:00Z' },
    { id: 'billing-api', title: 'Billing API', repository: { provider: 'github', location: { owner: 'acme', repository: 'billing' }, branch: 'main' } },
  ])
  await openCitation(store, index, 'old-notes')
  await openCitation(store, index, 'nobody')
  await openCitation(store, null, 'client-brief')
  assert.deepEqual(reads, [], 'nothing was read')

  await assert.rejects(openCitation(store, index, 'client-brief'), /The file for "Client brief" is missing/)
  assert.deepEqual(reads, ['client-brief'])

  const opened = []
  globalThis.window = { open: (...args) => opened.push(args) }
  try {
    await openCitation(store, index, 'billing-api?path=src/orders.ts&commit=3f2a9c1')
  } finally {
    delete globalThis.window
  }
  assert.equal(opened.length, 1)
  assert.match(opened[0][0], /^https:\/\/github\.com\/acme\/billing\/blob\/3f2a9c1\/src\/orders\.ts$/)
  assert.equal(reads.length, 1, 'a repository is not read from the store')
})

// A node with no children to find: enough to see what was drawn into it and which steps looked at it.
function standInNode() {
  const asked = []
  return {
    asked,
    innerHTML: '',
    querySelectorAll(selector) {
      asked.push(selector)
      return []
    },
  }
}

test('the preview resolves asset references before it renders, then turns citations into links, draws diagrams and marks image captions', () => {
  const node = standInNode()
  renderMarkdownPreview(node, 'See ![chart](asset:a1).\n\n**Bold** and [the brief](source:client-brief).', {
    resolveAssets: (text) => text.replace('asset:a1', '/api/instance/assets/a1/file'),
    sources: { index: {}, open: () => {} },
  })
  assert.match(node.innerHTML, /<img src="\/api\/instance\/assets\/a1\/file" alt="chart" class="asset-thumb">/)
  assert.match(node.innerHTML, /<strong>Bold<\/strong>/)
  assert.match(node.innerHTML, /<a href="source:client-brief" target="_blank" rel="noreferrer">the brief<\/a>/)
  assert.deepEqual(node.asked, ['a[href^="source:"]', 'pre > code.language-mermaid', 'p'])
  assert.equal(typeof node.onclick, 'function', 'one click handler on the preview opens a citation')
})

test('with no asset resolver the text is rendered as it is, and with no node nothing happens', () => {
  const node = standInNode()
  renderMarkdownPreview(node, '![chart](asset:a1)')
  assert.match(node.innerHTML, /<img src="asset:a1" alt="chart">/)
  assert.doesNotThrow(() => renderMarkdownPreview(null, '# Heading'))
})

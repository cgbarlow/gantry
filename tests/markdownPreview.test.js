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

// #347: the AI interview's thread draws the AI's replies through this preview. The issue's example reply, from a SOAP stage on 0.16.0, which
// showed its Markdown raw.
const SOAP_REPLY = `Every Field the sources support is now drafted in the preview, and nothing is saved yet.

- **Your answers:** the Fields they feed are redrafted. The storage answer was "Whichever of the two that gantry now supports is in scope".
- **Open questions:** the table has Q1 to Q10.
- **Warning:** Gantry flagged the year "2027" in Sequencing as unsourced.

Five things in the drafts are worth a check:
- **Azure Files:** the Azure Files and Azure Blob question stays open (Q1).
- **Registry connection:** the release pipeline still has a \`<set-me>\` registry connection placeholder, which I didn't draft into any Field.

Is there anything you want to change before the stage-end card?`

test('an AI reply shaped like the SOAP example: two bulleted lists with bold labels, separate paragraphs, and <set-me> as inline code', () => {
  const node = standInNode()
  renderMarkdownPreview(node, SOAP_REPLY, { sources: { index: {} } })
  const html = node.innerHTML
  assert.equal(html.match(/<ul>/g)?.length, 2, 'two lists, the second straight after a paragraph line')
  assert.equal(html.match(/<li>/g)?.length, 5)
  assert.equal(html.match(/<p>/g)?.length, 3, 'three paragraphs')
  for (const label of ['Your answers:', 'Open questions:', 'Warning:', 'Azure Files:', 'Registry connection:']) assert.ok(html.includes(`<strong>${label}</strong>`), label)
  assert.ok(html.includes('<code>&lt;set-me&gt;</code>'), 'the placeholder is code, shown as typed')
  assert.ok(!html.includes('**') && !/^- /m.test(html), 'no raw Markdown is left')
})

test('a heading, a table and a fenced code block render; the HTML has no trailing blank line, so a one-line reply reads as its words', () => {
  const node = standInNode()
  renderMarkdownPreview(node, '### Next steps\n\n| Q | Answer |\n| - | - |\n| Q1 | Open |\n\n```yaml\nregistry: <set-me>\n```')
  assert.match(node.innerHTML, /<h3 id="next-steps">Next steps<\/h3>/)
  assert.match(node.innerHTML, /<table>[\s\S]*<td>Q1<\/td>[\s\S]*<\/table>/)
  assert.match(node.innerHTML, /<pre><code class="language-yaml">registry: &lt;set-me&gt;\n<\/code><\/pre>$/)
  renderMarkdownPreview(node, 'Picking up where I stopped.')
  assert.equal(node.innerHTML, '<p>Picking up where I stopped.</p>')
})

test('mermaid: false leaves the diagrams undrawn (a reply still arriving), and the default draws them', () => {
  const streaming = standInNode()
  renderMarkdownPreview(streaming, '```mermaid\ngraph TD\n  A --> B\n```', { mermaid: false })
  assert.ok(!streaming.asked.includes('pre > code.language-mermaid'))
  assert.match(streaming.innerHTML, /<code class="language-mermaid">/)
  const finished = standInNode()
  renderMarkdownPreview(finished, '```mermaid\ngraph TD\n  A --> B\n```')
  assert.ok(finished.asked.includes('pre > code.language-mermaid'))
})

test('a reply drawn piece by piece renders at every point, part-way through a fence or a table included', () => {
  const reply = `${SOAP_REPLY}\n\n| Q | Answer |\n| - | - |\n| Q1 | Open |\n\n\`\`\`js\nconst registry = '<set-me>'\n\`\`\`\n\nDone.`
  const node = standInNode()
  for (let end = 0; end <= reply.length; end += 7) assert.doesNotThrow(() => renderMarkdownPreview(node, reply.slice(0, end), { mermaid: false }), `at ${end}`)
  // An unclosed fence is code to the end of what has arrived.
  renderMarkdownPreview(node, 'Here it is:\n\n```js\nconst a = 1', { mermaid: false })
  assert.match(node.innerHTML, /<pre><code class="language-js">const a = 1<\/code><\/pre>$/)
  renderMarkdownPreview(node, reply)
  assert.match(node.innerHTML, /<p>Done\.<\/p>$/)
})
